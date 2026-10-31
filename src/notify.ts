/**
 * Outbound notifications for states that need a human.
 *
 * The HUD can only be looked at; when the user is in another tmux window it
 * has no way to say "this session is waiting on you". The states worth
 * interrupting someone for are the ones the detectors already confirm — an
 * approval prompt, a stream-error-killed turn, a quota hit, a turn Codex
 * itself ended on an error — plus a long turn finishing, which is what the
 * user walked away from in the first place.
 *
 * Delivery is a user command (`CODEX_HUD_NOTIFY_CMD`), run through `sh -c`
 * with the event JSON on stdin and in `CODEX_HUD_EVENT_JSON`; the event name
 * alone rides in `CODEX_HUD_EVENT`. The HUD ships no notifier of its own —
 * osascript, tmux display-message, or a fleet bridge are one-liners away and
 * the right one is the user's call. Unset, this module costs nothing.
 *
 * Only transitions fire. The first observation after start or rebind seeds
 * the baseline silently: a HUD launched in front of a session already waiting
 * for approval would otherwise notify about the screen the user is looking
 * at. A per-event cooldown keeps a flapping detector from paging repeatedly.
 */

import { runShellCommand } from './notify-command.js';
export { runShellCommand, stopNotifications } from './notify-command.js';

import { logHudError } from './utils/hud-log.js';
import type { RateLimitSnapshot } from './types.js';

export type HudNotifyEvent =
  | 'approval-needed'
  | 'turn-interrupted'
  | 'limit-reached'
  | 'turn-completed'
  | 'turn-failed';

export interface NotifyContext {
  sessionId?: string;
  turnId?: string;
  approvalId?: string;
  /** Account/data scope and quota window, independent of the active turn. */
  quotaScope?: string;
  tmuxSession?: string;
  cwd: string;
  /** Wall time of the finished turn; rides in the turn-completed and turn-failed payloads. */
  lastTurnDurationMs?: number;
  /** Codex's verdict on a failed turn; rides in the turn-failed payload. */
  lastTurnError?: { code?: string; message?: string };
}

export type NotifyStates = Record<HudNotifyEvent, boolean>;

const EVENT_NAMES: readonly HudNotifyEvent[] = [
  'approval-needed',
  'turn-interrupted',
  'limit-reached',
  'turn-completed',
  'turn-failed',
];

/**
 * Shortest finished turn worth announcing. Every other notifier in this
 * user's grid (the cmux bridge, the fleet monitor) pages on completion, and a
 * conversational back-and-forth would page on every reply without a floor;
 * three minutes is the same threshold the cmux bridge settled on for the same
 * problem. Short turns end with the user already watching.
 */
export const MIN_COMPLETED_TURN_MS = 180_000;

/**
 * Whether the session is in the turn-completed state. The phase is the
 * overlay-adjusted one on purpose: with Codex gone it reads `exited`, so
 * quitting right after a turn never pages about a completion nobody awaits.
 * Kept beside the threshold so the pane wiring and the tests share one
 * predicate.
 */
export function isCompletedTurnNotifiable(
  phase: string | undefined,
  lastTurnDurationMs: number | undefined
): boolean {
  return (
    phase === 'idle' &&
    lastTurnDurationMs !== undefined &&
    Number.isFinite(lastTurnDurationMs) &&
    lastTurnDurationMs >= MIN_COMPLETED_TURN_MS
  );
}

/** A state that clears and trips again within this window fires once. */
const REFIRE_COOLDOWN_MS = 5 * 60_000;

export function rateLimitNotificationScope(account: string, limits?: RateLimitSnapshot): string {
  return JSON.stringify([account, limits?.limit_id,
    limits?.primary?.window_minutes, limits?.primary?.resets_at,
    limits?.secondary?.window_minutes, limits?.secondary?.resets_at]);
}

function eventScope(event: HudNotifyEvent, context: NotifyContext): string {
  if (event === 'limit-reached') return context.quotaScope ?? 'account';
  return JSON.stringify([context.sessionId, context.turnId,
    event === 'approval-needed' ? context.approvalId : undefined]);
}

export class HudNotifier {
  private readonly command: string | undefined;
  private readonly run: (command: string, payload: string) => Promise<void>;
  private seeded = false;
  private lastState: NotifyStates = {
    'approval-needed': false,
    'turn-interrupted': false,
    'limit-reached': false,
    'turn-completed': false,
    'turn-failed': false,
  };
  private lastScopes: Partial<Record<HudNotifyEvent, string>> = {};
  private lastFiredMs: Partial<Record<HudNotifyEvent, number>> = {};

  constructor(options?: {
    command?: string;
    runCommand?: (command: string, payload: string) => Promise<void>;
  }) {
    this.command = options?.command ?? process.env.CODEX_HUD_NOTIFY_CMD;
    this.run = options?.runCommand ?? runShellCommand;
  }

  /**
   * Rebinding changes which session the states describe; the next observation
   * seeds the new baseline instead of reading the switch as transitions.
   */
  reset(): void {
    this.seeded = false;
    this.lastFiredMs = {};
    this.lastScopes = {};
    this.lastState = {
      'approval-needed': false,
      'turn-interrupted': false,
      'limit-reached': false,
      'turn-completed': false,
      'turn-failed': false,
    };
  }

  /**
   * Record the current states and fire the user command for each rising edge
   * past its cooldown. Returns the events fired (for tests); never throws.
   */
  observe(
    states: NotifyStates,
    context: NotifyContext,
    nowMs: number = Date.now()
  ): HudNotifyEvent[] {
    const fired: HudNotifyEvent[] = [];
    try {
      const previous = this.lastState;
      const wasSeeded = this.seeded;
      this.lastState = { ...states };
      this.seeded = true;
      for (const event of EVENT_NAMES) {
        const scope = eventScope(event, context);
        const scopeChanged = scope !== this.lastScopes[event];
        if (scopeChanged) delete this.lastFiredMs[event];
        this.lastScopes[event] = scope;
        if (!this.command || !wasSeeded) continue;
        if (!states[event] || (previous[event] && !scopeChanged)) {
          continue;
        }
        const firedAt = this.lastFiredMs[event];
        if (firedAt !== undefined && nowMs - firedAt < REFIRE_COOLDOWN_MS) {
          continue;
        }
        this.lastFiredMs[event] = nowMs;
        fired.push(event);
        const payload = JSON.stringify({
          event,
          ...(context.sessionId ? { sessionId: context.sessionId } : {}),
          ...(context.tmuxSession ? { tmuxSession: context.tmuxSession } : {}),
          cwd: context.cwd,
          at: new Date(nowMs).toISOString(),
          ...((event === 'turn-completed' || event === 'turn-failed') &&
          context.lastTurnDurationMs !== undefined &&
          Number.isFinite(context.lastTurnDurationMs)
            ? { turnDurationMs: Math.round(context.lastTurnDurationMs) }
            : {}),
          ...(event === 'turn-failed' && context.lastTurnError
            ? { error: context.lastTurnError }
            : {}),
        });
        void this.run(this.command, payload).catch((error) => {
          logHudError('notify', error);
        });
      }
    } catch (error) {
      // Notification is a side channel; it must never take the HUD down.
      logHudError('notify', error);
    }
    return fired;
  }
}
