/**
 * Is the main pane showing a brand-new Codex session instead of the bound one?
 *
 * After `/new`, codex 0.149 registers nothing until the first message: the
 * rollout is created lazily (long known), the threads-db row is now deferred
 * too (verified live — no row appeared in five hours), and the process holds
 * no rollout file open. The fresh session is therefore invisible to every
 * data source the HUD has, and the binding stays on the previous session —
 * observed live as `✗ Turn aborted · event 5h ago` under a pane whose footer
 * read `Context 100% left · Ready`.
 *
 * The pane footer is the only witness, so this detector follows the
 * approval/stall pattern: probe only once the persisted structure is a quiet
 * terminal state, require the calibrated footer text, treat capture failures
 * as no evidence, and clear for free on any new rollout event or working
 * phase (the first message makes the real binding catch up within seconds).
 */

import { execFile } from 'child_process';

import type { TurnActivity } from '../types.js';

/** Quiet time before the pane is worth asking; a turn boundary is not `/new`. */
export const FRESH_PROMPT_SILENCE_MS = 60_000;
export const FRESH_PROMPT_PROBE_INTERVAL_MS = 60_000;

const TMUX_CAPTURE_TIMEOUT_MS = 3_000;
const TMUX_CAPTURE_MAX_BUFFER = 256 * 1024;

export interface FreshPromptProbeInput {
  turnActivity?: TurnActivity | null;
  lastEventAt?: Date | null;
}

type CapturePane = (pane: string) => Promise<string | null>;

export interface FreshPromptDetectorOptions {
  mainPane?: string;
  silenceMs?: number;
  probeIntervalMs?: number;
  capturePane?: CapturePane;
}

function dateMs(value: Date | null | undefined): number {
  const timestamp = value?.getTime();
  return timestamp !== undefined && Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Only quiet terminal states pose the question. Working phases mean the
 * rollout is being written — the pane demonstrably still runs the bound
 * session — and `exited` means there is no Codex left to show a footer.
 */
export function isFreshPromptProbeCandidate(
  input: FreshPromptProbeInput,
  nowMs: number = Date.now(),
  silenceMs: number = FRESH_PROMPT_SILENCE_MS
): boolean {
  const phase = input.turnActivity?.phase;
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(silenceMs) ||
    silenceMs < 0 ||
    (phase !== 'idle' && phase !== 'aborted' && phase !== 'interrupted')
  ) {
    return false;
  }
  const lastSeenMs = Math.max(
    dateMs(input.lastEventAt),
    dateMs(input.turnActivity?.lastActivityAt)
  );
  return lastSeenMs > 0 && nowMs - lastSeenMs >= silenceMs;
}

/**
 * The 0.149 composer footer for an unused session, calibrated live:
 * `Context 100% left · Ready · Full Access · Fast off`. The two cells are
 * matched together because either alone is ambiguous — `Ready` is the idle
 * state word for any session, and only a session with no turns at all still
 * has 100% of its context (on this machine the workspace instructions alone
 * cost over 1% on the first turn). A footer wording change upstream fails
 * closed: the overlay simply never appears.
 */
export function containsFreshSessionFooter(screen: string): boolean {
  if (!screen) {
    return false;
  }
  const tail = screen
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-5);
  return tail.some((line) =>
    /\bContext 100% left\s*·\s*Ready\b/.test(line)
  );
}

function captureTmuxPane(pane: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'tmux',
      ['capture-pane', '-p', '-J', '-t', pane],
      {
        encoding: 'utf8',
        timeout: TMUX_CAPTURE_TIMEOUT_MS,
        maxBuffer: TMUX_CAPTURE_MAX_BUFFER,
      },
      (error, stdout) => resolve(error ? null : stdout)
    );
  });
}

export class FreshPromptDetector {
  private readonly mainPane?: string;
  private readonly silenceMs: number;
  private readonly probeIntervalMs: number;
  private readonly capturePane: CapturePane;
  private freshSession = false;
  private lastProbeAtMs = Number.NEGATIVE_INFINITY;
  private probeInFlight = false;
  private generation = 0;

  constructor(options: FreshPromptDetectorOptions = {}) {
    this.mainPane = options.mainPane;
    this.silenceMs = options.silenceMs ?? FRESH_PROMPT_SILENCE_MS;
    this.probeIntervalMs =
      options.probeIntervalMs ?? FRESH_PROMPT_PROBE_INTERVAL_MS;
    this.capturePane = options.capturePane ?? captureTmuxPane;
  }

  isPaneOnFreshSession(): boolean {
    return this.freshSession;
  }

  /** A rebind means the pane's session was found; the question restarts. */
  reset(): boolean {
    const changed = this.freshSession;
    this.generation++;
    this.freshSession = false;
    this.lastProbeAtMs = Number.NEGATIVE_INFINITY;
    return changed;
  }

  /** Refresh the cached state; returns true only when the answer changed. */
  async refresh(
    input: FreshPromptProbeInput,
    nowMs: number = Date.now()
  ): Promise<boolean> {
    if (!isFreshPromptProbeCandidate(input, nowMs, this.silenceMs)) {
      // A working phase or fresh event proves the pane still runs the bound
      // session; drop the claim without spending a capture.
      if (this.probeInFlight) {
        this.generation++;
      }
      if (!this.freshSession) {
        return false;
      }
      this.freshSession = false;
      return true;
    }

    if (
      !this.mainPane ||
      this.probeInFlight ||
      nowMs - this.lastProbeAtMs < this.probeIntervalMs
    ) {
      return false;
    }

    this.lastProbeAtMs = nowMs;
    this.probeInFlight = true;
    const generation = this.generation;
    try {
      const screen = await this.capturePane(this.mainPane);
      // A rebind invalidates an in-flight capture from the prior binding.
      if (generation !== this.generation) {
        return false;
      }
      // A transient tmux failure proves nothing either way.
      if (screen === null) {
        return false;
      }
      const next = containsFreshSessionFooter(screen);
      if (next === this.freshSession) {
        return false;
      }
      this.freshSession = next;
      return true;
    } finally {
      this.probeInFlight = false;
    }
  }
}
