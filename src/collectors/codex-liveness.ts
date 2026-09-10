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
 * free proof of life (no spawn), and the ps walk
 * runs at most once a minute — so it effectively runs only for quiet
 * sessions, which is exactly where the question exists.
 */

import { execFile } from 'child_process';

import type { TurnActivity } from '../types.js';
import { startProbe } from '../utils/probe-latency.js';
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
 * A recent event proves life; a persisted working phase alone does not.
 * A crash mid-turn leaves that phase behind indefinitely.
 */
export function isLivenessProbeCandidate(
  input: LivenessProbeInput,
  nowMs: number = Date.now(),
  graceMs: number = LIVENESS_EVENT_GRACE_MS
): boolean {
  if (!Number.isFinite(nowMs) || !Number.isFinite(graceMs) || graceMs < 0) {
    return false;
  }
  for (const date of [input.lastEventAt, input.turnActivity?.lastActivityAt]) {
    const eventMs = date?.getTime();
    if (eventMs !== undefined && Number.isFinite(eventMs) && nowMs - eventMs < graceMs) {
      return false;
    }
  }
  return true;
}

export interface CodexProcess {
  pid: string;
  command: string;
}

/**
 * The Codex process found in the descendant tree of `rootPid`, or undefined
 * when there is none. Exported so the walk is provable against the
 * live-calibrated process shape (shell -> node .../bin/codex). The command
 * line itself is the only witness for launch flags (`--yolo`,
 * `--ask-for-approval`) while a fresh 0.149 session has written no rollout;
 * the pid lets later probes answer with a signal-0 check instead of a walk.
 */
export function codexProcessInTree(
  psOutput: string,
  rootPid: string
): CodexProcess | undefined {
  if (!/^\d+$/.test(rootPid)) {
    return undefined;
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
      return { pid, command };
    }
    queue.push(...(childrenByParent.get(pid) ?? []));
  }
  return undefined;
}

export function codexCommandInTree(
  psOutput: string,
  rootPid: string
): string | undefined {
  return codexProcessInTree(psOutput, rootPid)?.command;
}

export function treeContainsCodex(psOutput: string, rootPid: string): boolean {
  return codexCommandInTree(psOutput, rootPid) !== undefined;
}

export interface PaneCodexProbeResult {
  alive: boolean;
  /** The matched invocation's `ps` command line; set only when alive. */
  command?: string;
  /** The matched process id; set only when alive and known. */
  pid?: string;
}

/** Signal 0 asks the kernel whether a pid exists without touching it. */
export function isProcessAlive(pid: string): boolean {
  if (!/^\d+$/.test(pid)) {
    return false;
  }
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

type PaneProcessProbe = (pane: string) => Promise<PaneCodexProbeResult | null>;

async function probePaneForCodex(
  pane: string
): Promise<PaneCodexProbeResult | null> {
  const run = (
    file: string,
    args: readonly string[]
  ): Promise<string | null> =>
    new Promise((resolve) => {
      const finishProbe = startProbe(file === 'ps' ? 'ps' : 'tmux');
      execFile(
        file,
        args,
        {
          encoding: 'utf8',
          timeout: SPAWN_TIMEOUT_MS,
          maxBuffer: PS_MAX_BUFFER,
        },
        (error, stdout) => {
          finishProbe();
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
  const found = codexProcessInTree(table, panePid);
  return found === undefined
    ? { alive: false }
    : { alive: true, command: found.command, pid: found.pid };
}

export interface CodexLivenessOptions {
  mainPane?: string;
  probeIntervalMs?: number;
  eventGraceMs?: number;
  probePane?: PaneProcessProbe;
  /** Test hook for the pid fast path. */
  isAlive?: (pid: string) => boolean;
}

export class CodexLivenessProbe {
  private readonly mainPane: string | undefined;
  private readonly probeIntervalMs: number;
  private readonly eventGraceMs: number;
  private readonly probePane: PaneProcessProbe;
  private readonly isAlive: (pid: string) => boolean;
  private gone = false;
  private codexCommand: string | undefined;
  private codexPid: string | undefined;
  private lastProbeMs = 0;
  private generation = 0;
  private inFlight = false;

  constructor(options: CodexLivenessOptions = {}) {
    this.mainPane = options.mainPane;
    this.probeIntervalMs =
      options.probeIntervalMs ?? LIVENESS_PROBE_INTERVAL_MS;
    this.eventGraceMs = options.eventGraceMs ?? LIVENESS_EVENT_GRACE_MS;
    this.probePane = options.probePane ?? probePaneForCodex;
    this.isAlive = options.isAlive ?? isProcessAlive;
  }

  isCodexGone(): boolean {
    return this.gone;
  }

  /**
   * The pane's Codex invocation as of the last successful probe; undefined
   * until one runs or after Codex is found gone. Consumers read launch flags
   * off it — the only policy witness while no rollout exists.
   */
  getCodexCommand(): string | undefined {
    return this.codexCommand;
  }

  /** A rebind changes whose pane the answer describes. */
  reset(): void {
    this.gone = false;
    this.codexCommand = undefined;
    this.codexPid = undefined;
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
      // Fresh events also invalidate a slow probe started before the write.
      if (this.inFlight) {
        this.generation++;
      }
      if (this.gone) {
        this.gone = false;
        return true;
      }
      return false;
    }
    if (this.inFlight || nowMs - this.lastProbeMs < this.probeIntervalMs) {
      return false;
    }
    // The Codex pid the last walk found answers with one syscall while it
    // lives; only its death (or a pid never learned) is worth the tmux and
    // ps spawns — 0.3-5.4s and 0.5-0.8s of wall time each on this machine.
    if (
      !this.gone &&
      this.codexPid !== undefined &&
      this.isAlive(this.codexPid)
    ) {
      this.lastProbeMs = nowMs;
      return false;
    }
    this.lastProbeMs = nowMs;
    this.inFlight = true;
    const generationAtStart = this.generation;
    let probed: PaneCodexProbeResult | null;
    try {
      probed = await this.probePane(this.mainPane);
    } catch {
      probed = null;
    } finally {
      this.inFlight = false;
    }
    if (generationAtStart !== this.generation || probed === null) {
      return false;
    }
    const gone = !probed.alive;
    const command = probed.alive ? probed.command : undefined;
    this.codexPid = probed.alive ? probed.pid : undefined;
    if (gone === this.gone && command === this.codexCommand) {
      return false;
    }
    this.gone = gone;
    this.codexCommand = command;
    return true;
  }
}
