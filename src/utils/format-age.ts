/**
 * Duration formatting shared by every HUD row.
 *
 * Three copies of this logic had drifted apart and two of them capped at
 * hours, so a session idle for eleven days rendered "event 284h ago". One
 * module keeps the units consistent and the day cap in one place.
 */

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Single-unit age used by inline suffixes ("event 3m ago", overview rows).
 * Days gain an hour part because "11d" alone loses too much resolution at the
 * point where a session is old enough to matter.
 */
export function formatCompactAge(durationMs: number): string {
  const safeMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;

  if (safeMs < MINUTE_MS) {
    return `${Math.floor(safeMs / SECOND_MS)}s`;
  }
  if (safeMs < HOUR_MS) {
    return `${Math.floor(safeMs / MINUTE_MS)}m`;
  }
  if (safeMs < DAY_MS) {
    return `${Math.floor(safeMs / HOUR_MS)}h`;
  }

  const days = Math.floor(safeMs / DAY_MS);
  const hours = Math.floor((safeMs % DAY_MS) / HOUR_MS);
  return hours > 0 ? `${days}d${hours}h` : `${days}d`;
}

/**
 * Compound duration ("2h13m") used where a single unit loses too much
 * resolution: the "up ..." cell and the "resets in ..." countdown.
 */
export function formatCompoundDuration(durationMs: number): string {
  const elapsedMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  const seconds = Math.floor(elapsedMs / SECOND_MS);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

/**
 * Compound uptime used by the "up ..." cell, which carries the finer unit
 * because it is the row's only time signal.
 */
export function formatUptime(startTime: Date, nowMs: number = Date.now()): string {
  const startedAtMs = startTime.getTime();
  if (!Number.isFinite(startedAtMs)) {
    return '0s';
  }
  return formatCompoundDuration(nowMs - startedAtMs);
}
