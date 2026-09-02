/**
 * Retention of rate-limit windows across Codex's windowless snapshots.
 *
 * The moment a limit is spent Codex writes a snapshot with no window at all:
 * measured 2026-08-31 09:31:32Z, one second after the 5h window read 100%,
 * the next `token_count` carried `limit_id:"premium"`, both windows null and
 * a zeroed credit pool. Replacing the previous snapshot wholesale drops the
 * spent window with its `resets_at` — the one number that says when work can
 * resume, and the number the Codex TUI kept showing as "try again at 9:18 PM".
 *
 * Windows are fixed blocks (see quota-trend): a null slot does not mean the
 * block ended, so each slot keeps its last dated reading until that reading's
 * own reset passes. The result is marked so the quota row can still tell the
 * exhaustion apart from an ordinary reading of the same windows.
 */

import type { RateLimitSnapshot, RateLimitWindow } from '../types.js';

function isLiveDatedWindow(
  window: RateLimitWindow | null | undefined,
  nowMs: number
): window is RateLimitWindow {
  return (
    Boolean(window) &&
    window?.resets_at !== undefined &&
    Number.isFinite(window.resets_at) &&
    window.resets_at * 1000 > nowMs
  );
}

/** Whether a snapshot states any window level of its own. */
export function statesRateLimitWindow(snapshot: RateLimitSnapshot): boolean {
  return (
    snapshot.primary?.used_percent !== undefined ||
    snapshot.secondary?.used_percent !== undefined
  );
}

/**
 * The snapshot to keep after `incoming` arrives on top of `previous`: the
 * incoming one itself whenever it states a window, otherwise the incoming
 * one with every null slot filled from the previous reading that has not
 * reset yet, marked `windowsRetained`.
 */
export function retainRateLimitWindows(
  previous: RateLimitSnapshot | null | undefined,
  incoming: RateLimitSnapshot,
  nowMs: number
): RateLimitSnapshot {
  if (!previous || statesRateLimitWindow(incoming)) {
    return incoming;
  }
  const primary =
    incoming.primary ??
    (isLiveDatedWindow(previous.primary, nowMs) ? previous.primary : null);
  const secondary =
    incoming.secondary ??
    (isLiveDatedWindow(previous.secondary, nowMs) ? previous.secondary : null);
  if (!primary && !secondary) {
    return incoming;
  }
  // The windows belong to the pool the previous reading named (`codex`);
  // the windowless record names the credit pool (`premium`). Keeping the
  // former lets the account-wide chooser compare this against other panes'
  // plain readings as one pool rather than refusing the substitution.
  return {
    ...incoming,
    limit_id: previous.limit_id ?? incoming.limit_id,
    primary,
    secondary,
    windowsRetained: true,
  };
}
