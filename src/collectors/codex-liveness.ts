/**
 * Is there still a Codex process behind the main pane?
 *
 * When Codex exits — quit, crash, or the trust prompt declined — the wrapper
 * execs the user's shell so the tmux session stays reusable. Nothing writes
 * that fact anywhere the HUD reads: the rollout just stops, and the pane
 * rendered "Idle · waiting for you" (or "Waiting for a Codex session…") for
 * a session nothing would ever resume. Observed live 2026-08-20 in a scratch
 * session: Codex quit at the trust prompt and the HUD kept "waiting".
 *
 * tmux cannot answer this cheaply: Codex runs as `node .../bin/codex`, a
 * grandchild of the pane shell, so `pane_current_command` reads "zsh" the
 * whole time (measured on the same scratch session). The probe therefore
 * resolves the pane's root pid and walks the process table with the same
 * Codex-invocation matcher the runtime-hooks collector uses.
 *
 * Cost control mirrors the other pane detectors: a fresh rollout event is
 * free proof of life (no spawn), working phases never probe, and the ps walk
 * runs at most once a minute — so it effectively runs only for quiet
 * sessions, which is exactly where the question exists.
 */

import { execFile } from 'child_process';

import type { TurnActivity } from '../types.js';
import { isCodexProcessCommand } from './runtime-hooks.js';

export const LIVENESS_PROBE_INTERVAL_MS = 60_000;
/** A rollout event this recent proves Codex alive without any spawn. */
export const LIVENESS_EVENT_GRACE_MS = 60_000;

/** Matches the session-finder probe budget, set for this machine's measured
 * 0.7-2.1s spawn latency under load. */
const SPAWN_TIMEOUT_MS = 8000;
const PS_MAX_BUFFER = 10 * 1024 * 1024;
/** Generous bound on one pane's descendant walk. */
const MAX_TREE_PIDS = 64;

export interface LivenessProbeInput {
  turnActivity?: TurnActivity | null;
  lastEventAt?: Date | null;
}

/**
 * Whether the question "did Codex exit?" is even open. A working phase means
 * the rollout is being written, and a recent event is the same proof for
 * free; only quiet terminal states (or no turn state at all) warrant a probe.
 */
export function isLivenessProbeCandidate(
  input: LivenessProbeInput,
  nowMs: number = Date.now(),
  graceMs: number = LIVENESS_EVENT_GRACE_MS
): boolean {
  if (!Number.isFinite(nowMs) || !Number.isFinite(graceMs) || graceMs < 0) {
    return false;
  }
  const phase = input.turnActivity?.phase;
  if (
    phase === 'thinking' ||
    phase === 'responding' ||
    phase === 'running-tool' ||
    phase === 'awaiting-approval'
  ) {
    return false;
  }
  const lastEventMs = input.lastEventAt?.getTime();
  if (
    lastEventMs !== undefined &&
    Number.isFinite(lastEventMs) &&
    nowMs - lastEventMs < graceMs
  ) {
    return false;
  }
  return true;
}

/**
 * Whether a `ps -axo pid=,ppid=,command=` table contains a Codex invocation
 * in the descendant tree of `rootPid`. Exported so the walk is provable
 * against the live-calibrated process shape (shell -> node .../bin/codex).
 */
export function treeContainsCodex(psOutput: string, rootPid: string): boolean {
  if (!/^\d+$/.test(rootPid)) {
    return false;
  }
  const childrenByParent = new Map<string, string[]>();
  const commandsByPid = new Map<string, string>();
  for (const line of psOutput.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)(?:\s+(.*))?$/);
    if (!match) {
      continue;
    }
    commandsByPid.set(match[1], match[3] ?? '');
    const siblings = childrenByParent.get(match[2]) ?? [];
    siblings.push(match[1]);
    childrenByParent.set(match[2], siblings);
  }

  const seen = new Set<string>();
  const queue = [rootPid];
  while (queue.length > 0 && seen.size < MAX_TREE_PIDS) {
    const pid = queue.shift();
    if (!pid || seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    const command = commandsByPid.get(pid);
    if (command && isCodexProcessCommand(command)) {
      return true;
    }
    queue.push(...(childrenByParent.get(pid) ?? []));
  }
  return false;
}

type PaneProcessProbe = (pane: string) => Promise<boolean | null>;

async function probePaneForCodex(pane: string): Promise<boolean | null> {
  const run = (
    file: string,
    args: readonly string[]
  ): Promise<string | null> =>
    new Promise((resolve) => {
      execFile(
        file,
        args,
        {
          encoding: 'utf8',
          timeout: SPAWN_TIMEOUT_MS,
          maxBuffer: PS_MAX_BUFFER,
        },
        (error, stdout) => {
          resolve(error ? null : stdout);
        }
      );
    });

  const panePid = (
    await run('tmux', ['display-message', '-p', '-t', pane, '#{pane_pid}'])
  )?.trim();
  if (!panePid || !/^\d+$/.test(panePid)) {
    return null;
  }
  const table = await run('ps', ['-axo', 'pid=,ppid=,command=']);
  if (table === null) {
    return null;
  }
  return treeContainsCodex(table, panePid);
}

export interface CodexLivenessOptions {
  mainPane?: string;
  probeIntervalMs?: number;
  eventGraceMs?: number;
  probePane?: PaneProcessProbe;
}

export class CodexLivenessProbe {
  private readonly mainPane: string | undefined;
  private readonly probeIntervalMs: number;
  private readonly eventGraceMs: number;
  private readonly probePane: PaneProcessProbe;
  private gone = false;
  private lastProbeMs = 0;
  private generation = 0;
  private inFlight = false;

  constructor(options: CodexLivenessOptions = {}) {
    this.mainPane = options.mainPane;
    this.probeIntervalMs =
      options.probeIntervalMs ?? LIVENESS_PROBE_INTERVAL_MS;
    this.eventGraceMs = options.eventGraceMs ?? LIVENESS_EVENT_GRACE_MS;
    this.probePane = options.probePane ?? probePaneForCodex;
  }

  isCodexGone(): boolean {
    return this.gone;
  }

  /** A rebind changes whose pane the answer describes. */
  reset(): void {
    this.gone = false;
    this.lastProbeMs = 0;
    this.generation++;
  }

  /**
   * Re-evaluate. Returns true when the answer changed. A failed probe (tmux
   * or ps unavailable) is no evidence either way and keeps the last answer.
   */
  async refresh(
    input: LivenessProbeInput,
    nowMs: number = Date.now()
  ): Promise<boolean> {
    if (!this.mainPane) {
      return false;
    }
    if (!isLivenessProbeCandidate(input, nowMs, this.eventGraceMs)) {
      // Working phases and fresh events are proof of life; clear for free.
      if (this.gone) {
        this.gone = false;
        return true;
      }
      return false;
    }
    if (this.inFlight || nowMs - this.lastProbeMs < this.probeIntervalMs) {
      return false;
    }
    this.lastProbeMs = nowMs;
    this.inFlight = true;
    const generationAtStart = this.generation;
    let alive: boolean | null;
    try {
      alive = await this.probePane(this.mainPane);
    } catch {
      alive = null;
    } finally {
      this.inFlight = false;
    }
    if (generationAtStart !== this.generation || alive === null) {
      return false;
    }
    const gone = !alive;
    if (gone === this.gone) {
      return false;
    }
    this.gone = gone;
    return true;
  }
}
