/**
 * Stream-error detection for the interactive Codex TUI.
 *
 * A stream error is drawn only on the TUI and never written to the rollout
 * (measured across three machines and fourteen days of rollouts: zero error
 * events; turn_aborted appears only for user-initiated interrupts). A turn it
 * kills therefore stays `thinking` in the parsed state forever, and the HUD
 * renders a live spinner over a dead turn. The durable evidence is the
 * `■`-prefixed error line the TUI leaves above the composer — it stays there
 * until the user resends, and new output pushes it away, which also ends the
 * overlay here. So after the rollout has been silent for minutes we capture
 * the already-known main pane and require that banner before changing the
 * displayed phase. Same double-signal shape as the approval detector.
 */

import { execFile } from 'child_process';

import { startProbe } from '../utils/probe-latency.js';

import type { TurnActivity } from '../types.js';

export const STALL_SILENCE_MS = 5 * 60_000;
export const STALL_PROBE_INTERVAL_MS = 30_000;

const TMUX_CAPTURE_TIMEOUT_MS = 3_000;
const TMUX_CAPTURE_MAX_BUFFER = 256 * 1024;

export interface StallProbeInput {
  turnActivity?: TurnActivity | null;
  lastEventAt?: Date | null;
}

type CapturePane = (pane: string) => Promise<string | null>;

export interface StallDetectorOptions {
  mainPane?: string;
  silenceMs?: number;
  probeIntervalMs?: number;
  capturePane?: CapturePane;
}

function dateMs(value: Date | null | undefined): number {
  const timestamp = value?.getTime();
  return timestamp !== undefined && Number.isFinite(timestamp)
    ? timestamp
    : 0;
}

export function isStallProbeCandidate(
  input: StallProbeInput,
  nowMs: number = Date.now(),
  silenceMs: number = STALL_SILENCE_MS
): boolean {
  const phase = input.turnActivity?.phase;
  // running-tool is excluded: a long build is legitimately silent for longer
  // than any threshold here, and the approval detector owns that phase.
  // thinking/responding write reasoning and message deltas continuously, so
  // minutes of silence there mean the stream is gone, not busy.
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(silenceMs) ||
    silenceMs < 0 ||
    (phase !== 'thinking' && phase !== 'responding')
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
 * Codex draws its API/stream failures as a `■`-prefixed line. The phrase list
 * is the one the fleet monitor measured from real failures on these panes;
 * `retrying` marks the automatic retry path, which recovers on its own and
 * must not read as a death. Only the last few visible lines count: an error
 * higher up the screen has already been scrolled past by later output.
 */
const STREAM_ERROR_PHRASES =
  /stream (?:disconnected|error)|overloaded|try again later|rate ?limit|internal server error|unexpected status|connection (?:reset|refused|closed)/i;
const BANNER_TAIL_LINES = 15;

export function containsStreamErrorBanner(screen: string): boolean {
  if (!screen) {
    return false;
  }
  const tail = screen
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-BANNER_TAIL_LINES);
  for (let index = tail.length - 1; index >= 0; index--) {
    const line = tail[index];
    if (!line.startsWith('■')) {
      continue;
    }
    const body = line.replace(/^■+/, '').trim();
    if (/retrying/i.test(body)) {
      continue;
    }
    if (STREAM_ERROR_PHRASES.test(body)) {
      return true;
    }
  }
  return false;
}

function captureTmuxPane(pane: string): Promise<string | null> {
  return new Promise((resolve) => {
    const finishProbe = startProbe('tmux');
    execFile(
      'tmux',
      ['capture-pane', '-p', '-J', '-t', pane],
      {
        encoding: 'utf8',
        timeout: TMUX_CAPTURE_TIMEOUT_MS,
        maxBuffer: TMUX_CAPTURE_MAX_BUFFER,
      },
      (error, stdout) => {
        finishProbe();
        resolve(error ? null : stdout);
      }
    );
  });
}

export class StallDetector {
  private readonly mainPane?: string;
  private readonly silenceMs: number;
  private readonly probeIntervalMs: number;
  private readonly capturePane: CapturePane;
  private likelyInterrupted = false;
  private lastProbeAtMs = Number.NEGATIVE_INFINITY;
  private probeInFlight = false;
  private generation = 0;

  constructor(options: StallDetectorOptions = {}) {
    this.mainPane = options.mainPane;
    this.silenceMs = options.silenceMs ?? STALL_SILENCE_MS;
    this.probeIntervalMs =
      options.probeIntervalMs ?? STALL_PROBE_INTERVAL_MS;
    this.capturePane = options.capturePane ?? captureTmuxPane;
  }

  isLikelyInterrupted(): boolean {
    return this.likelyInterrupted;
  }

  reset(): boolean {
    const changed = this.likelyInterrupted;
    this.generation++;
    this.likelyInterrupted = false;
    this.lastProbeAtMs = Number.NEGATIVE_INFINITY;
    return changed;
  }

  /** Refresh the cached state; returns true only when the visible state changed. */
  async refresh(
    input: StallProbeInput,
    nowMs: number = Date.now()
  ): Promise<boolean> {
    if (!isStallProbeCandidate(input, nowMs, this.silenceMs)) {
      // Any fresh rollout event or phase change ends the overlay: the turn
      // either recovered or was resent, and the banner claim is stale.
      if (this.probeInFlight) {
        this.generation++;
      }
      if (!this.likelyInterrupted) {
        return false;
      }
      this.likelyInterrupted = false;
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
      // Session changes invalidate an in-flight capture from the prior turn.
      if (generation !== this.generation) {
        return false;
      }
      // A transient tmux timeout proves nothing either way; keep the current
      // reading until a successful capture says otherwise.
      if (screen === null) {
        return false;
      }
      const next = containsStreamErrorBanner(screen);
      if (next === this.likelyInterrupted) {
        return false;
      }
      this.likelyInterrupted = next;
      return true;
    } finally {
      this.probeInFlight = false;
    }
  }
}
