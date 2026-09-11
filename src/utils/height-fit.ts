/**
 * Pane height that follows the content.
 *
 * The wrapper sizes the HUD pane to a sixth of the window (5-12 rows); at the
 * live 46-row terminal that is seven rows, which sat two rows blank on an idle
 * session and dropped live rows the moment agents or a plan appeared. This
 * policy asks tmux for the rows the unclipped layout wants, with hysteresis
 * so the Codex pane above is not reflowed on every flicker: growth is prompt
 * (throttled), shrinking waits for the content to stay small for a while, and
 * a height the user set by hand is left alone until the content changes.
 *
 * Pure decision logic; the tmux calls are injected.
 */

export interface HeightFitOptions {
  minRows: number;
  maxRows: number;
  /** Last program height, for detecting a drag before the first observation. */
  initialRows?: number;
  /** A manual override left by the wrapper, including across HUD reloads. */
  manualRows?: number;
  /** Minimum gap between two resizes the fitter itself requests. */
  growThrottleMs?: number;
  /** How long the content must stay smaller before the pane shrinks. */
  shrinkAfterMs?: number;
}

export const DEFAULT_GROW_THROTTLE_MS = 10_000;
export const DEFAULT_SHRINK_AFTER_MS = 120_000;

export class HeightFitPolicy {
  private readonly minRows: number;
  private readonly maxRows: number;
  private readonly growThrottleMs: number;
  private readonly shrinkAfterMs: number;
  private lastRequestedRows: number | null = null;
  private lastRequestAtMs = Number.NEGATIVE_INFINITY;
  private smallerSinceMs: number | null = null;
  /** Rows the user set by hand (pane height differs from the last request). */
  private manualRows: number | null = null;
  private manualWanted: number | null = null;

  constructor(options: HeightFitOptions) {
    this.minRows = Math.max(1, Math.floor(options.minRows));
    this.maxRows = Math.max(this.minRows, Math.floor(options.maxRows));
    this.growThrottleMs = options.growThrottleMs ?? DEFAULT_GROW_THROTTLE_MS;
    this.shrinkAfterMs = options.shrinkAfterMs ?? DEFAULT_SHRINK_AFTER_MS;
    if (options.initialRows !== undefined && Number.isInteger(options.initialRows) && options.initialRows > 0) {
      this.lastRequestedRows = options.initialRows;
    }
    if (options.manualRows !== undefined && Number.isInteger(options.manualRows) && options.manualRows > 0) {
      this.manualRows = options.manualRows;
    }
  }

  /**
   * Rows to request now, or null to leave the pane alone.
   *
   * @param wantedRows rows the unclipped layout renders
   * @param currentRows the pane's height as the terminal reports it
   */
  observe(wantedRows: number, currentRows: number, nowMs: number): number | null {
    if (
      !Number.isFinite(wantedRows) ||
      !Number.isFinite(currentRows) ||
      currentRows <= 0
    ) {
      return null;
    }
    const target = Math.min(
      this.maxRows,
      Math.max(this.minRows, Math.ceil(wantedRows))
    );
    // Establish a baseline even if the initial content already fits. A drag
    // before the first automatic resize must get the same protection.
    this.lastRequestedRows ??= currentRows;
    if (this.manualRows !== null && this.manualWanted === null) {
      this.manualWanted = target;
    }

    // A pane whose height is not the one last requested was sized by someone
    // else (a drag, the wrapper's hook, a rejected resize). Respect it until
    // the content wants a different number of rows than it did then.
    if (
      this.lastRequestedRows !== null &&
      (currentRows !== this.lastRequestedRows || this.manualRows === currentRows)
    ) {
      if (this.manualRows !== currentRows) {
        this.manualRows = currentRows;
        this.manualWanted = target;
      }
      if (target === this.manualWanted) {
        return null;
      }
    }

    if (target === currentRows) {
      this.smallerSinceMs = null;
      return null;
    }
    if (target > currentRows) {
      this.smallerSinceMs = null;
      if (nowMs - this.lastRequestAtMs < this.growThrottleMs) {
        return null;
      }
      return this.request(target, nowMs);
    }
    // Shrink only once the content has stayed smaller for a while.
    if (this.smallerSinceMs === null) {
      this.smallerSinceMs = nowMs;
      return null;
    }
    if (
      nowMs - this.smallerSinceMs < this.shrinkAfterMs ||
      nowMs - this.lastRequestAtMs < this.growThrottleMs
    ) {
      return null;
    }
    return this.request(target, nowMs);
  }

  private request(rows: number, nowMs: number): number {
    this.lastRequestedRows = rows;
    this.lastRequestAtMs = nowMs;
    this.smallerSinceMs = null;
    this.manualRows = null;
    this.manualWanted = null;
    return rows;
  }
}
