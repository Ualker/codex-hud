/**
 * Approval-wait detection for the interactive Codex TUI.
 *
 * Codex does not persist approval requests in the rollout stream. The only
 * durable signal there is an open tool call with no matching output, which is
 * indistinguishable from a quiet long-running command. We therefore probe the
 * already-known main tmux pane only after that structural state has stalled,
 * and require paired approval UI text before changing the HUD phase.
 */

import { execFile } from 'child_process';

import { startProbe } from '../utils/probe-latency.js';

import type { ToolActivity, TurnActivity } from '../types.js';

export const APPROVAL_STALL_MS = 5_000;
export const APPROVAL_PROBE_INTERVAL_MS = 10_000;

const TMUX_CAPTURE_TIMEOUT_MS = 3_000;
const TMUX_CAPTURE_MAX_BUFFER = 256 * 1024;

export interface ApprovalProbeInput {
  turnActivity?: TurnActivity | null;
  toolActivity?: ToolActivity | null;
  lastEventAt?: Date | null;
  approvalPolicy?: string;
}

type CapturePane = (pane: string) => Promise<string | null>;

export interface ApprovalDetectorOptions {
  mainPane?: string;
  stallMs?: number;
  probeIntervalMs?: number;
  capturePane?: CapturePane;
}

function dateMs(value: Date | null | undefined): number {
  const timestamp = value?.getTime();
  return timestamp !== undefined && Number.isFinite(timestamp)
    ? timestamp
    : 0;
}

export function isApprovalProbeCandidate(
  input: ApprovalProbeInput,
  nowMs: number = Date.now(),
  stallMs: number = APPROVAL_STALL_MS
): boolean {
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(stallMs) ||
    stallMs < 0 ||
    input.turnActivity?.phase !== 'running-tool' ||
    input.approvalPolicy?.toLowerCase() === 'never'
  ) {
    return false;
  }

  const running = input.toolActivity?.recentCalls.filter(
    (call) => call.status === 'running'
  ) ?? [];
  if (running.length === 0) {
    return false;
  }

  const oldestCallMs = Math.min(
    ...running.map((call) => dateMs(call.timestamp)).filter((value) => value > 0)
  );
  if (!Number.isFinite(oldestCallMs) || nowMs - oldestCallMs < stallMs) {
    return false;
  }

  const lastOutputMs = Math.max(
    dateMs(input.lastEventAt),
    dateMs(input.turnActivity.lastActivityAt),
    dateMs(input.toolActivity?.lastUpdateTime)
  );
  return lastOutputMs > 0 && nowMs - lastOutputMs >= stallMs;
}

/**
 * Match the current interactive surface, not a lone sentence that may occur
 * in transcript text. Codex 0.147 renders one of these titles together with
 * Yes/No choices or the common confirm/cancel footer. Pending subagent
 * approvals have their own `/agent to switch threads` companion line.
 */
export function containsApprovalPrompt(screen: string): boolean {
  if (!screen) {
    return false;
  }

  const pendingThread = /\bApproval needed in\s+[^\n]+/i.test(screen);
  if (
    pendingThread &&
    /\/agent\s+to switch threads\b/i.test(screen)
  ) {
    return true;
  }

  const hasTitle = [
    /Would you like to run the following command\?/i,
    /Do you want to approve network access to\s+["“][^\n"”]+["”]\?/i,
    /Would you like to grant these permissions\?/i,
    /Would you like to make the following edits\?/i,
    /[^\n]{1,100}\s+needs your approval\./i,
  ].some((pattern) => pattern.test(screen));
  if (!hasTitle) {
    return false;
  }

  const hasFooter =
    /\bto confirm\b/i.test(screen) && /\bto cancel\b/i.test(screen);
  const hasChoices =
    /(?:^|\n)\s*(?:[>›]\s*)?(?:\d+\.\s*)?Yes\b/im.test(screen) &&
    /(?:^|\n)\s*(?:[>›]\s*)?(?:\d+\.\s*)?No\b/im.test(screen);
  return hasFooter || hasChoices;
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

export class ApprovalDetector {
  private readonly mainPane?: string;
  private readonly stallMs: number;
  private readonly probeIntervalMs: number;
  private readonly capturePane: CapturePane;
  private approvalNeeded = false;
  private lastProbeAtMs = Number.NEGATIVE_INFINITY;
  private probeInFlight = false;
  private generation = 0;

  constructor(options: ApprovalDetectorOptions = {}) {
    this.mainPane = options.mainPane;
    this.stallMs = options.stallMs ?? APPROVAL_STALL_MS;
    this.probeIntervalMs =
      options.probeIntervalMs ?? APPROVAL_PROBE_INTERVAL_MS;
    this.capturePane = options.capturePane ?? captureTmuxPane;
  }

  isApprovalNeeded(): boolean {
    return this.approvalNeeded;
  }

  reset(): boolean {
    const changed = this.approvalNeeded;
    this.generation++;
    this.approvalNeeded = false;
    this.lastProbeAtMs = Number.NEGATIVE_INFINITY;
    return changed;
  }

  /** Refresh the cached state; returns true only when the visible state changed. */
  async refresh(
    input: ApprovalProbeInput,
    nowMs: number = Date.now()
  ): Promise<boolean> {
    if (!isApprovalProbeCandidate(input, nowMs, this.stallMs)) {
      if (this.probeInFlight) {
        this.generation++;
      }
      if (!this.approvalNeeded) {
        return false;
      }
      this.approvalNeeded = false;
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
      // A transient tmux timeout does not prove a previously observed prompt
      // disappeared; the structural state or a later successful probe clears it.
      if (screen === null) {
        return false;
      }
      const next = containsApprovalPrompt(screen);
      if (next === this.approvalNeeded) {
        return false;
      }
      this.approvalNeeded = next;
      return true;
    } finally {
      this.probeInFlight = false;
    }
  }
}
