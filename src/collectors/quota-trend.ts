/**
 * Projected exhaustion of the primary rate-limit window.
 *
 * The account's own history shows why a level gauge is not enough: measured
 * on this machine the weekly window burned ~24%/day and ran dry four days
 * before its reset, and the wall was hit both times with no warning beyond
 * the percentage itself. The snapshots to see it coming were all on disk —
 * each carries a timestamp — so two readings of one window give the slope,
 * and the slope says whether the money runs out before payday.
 *
 * State is two points in process memory: the earliest and the latest reading
 * of the current window this HUD has seen. A restart loses them and the
 * projection reappears once the baseline has rebuilt; nothing is persisted.
 */

import type { RateLimitSnapshot } from '../types.js';

export interface QuotaProjection {
  /** When the primary window reaches 100% at the observed pace. */
  exhaustsAtMs: number;
}

interface TrendPoint {
  usedPercent: number;
  atMs: number;
}

/**
 * Shortest baseline worth extrapolating. Right after a restart the two
 * points sit minutes apart, where one busy turn reads as a furious burn rate
 * and projects an exhaustion hours away; half an hour of separation damps
 * that without meaningfully delaying the signal on the day scale it serves.
 */
const MIN_BASELINE_MS = 30 * 60_000;

export class QuotaTrendTracker {
  private resetsAt: number | null = null;
  private first: TrendPoint | null = null;
  private latest: TrendPoint | null = null;

  /**
   * Record one reading. Observations may arrive out of order — the bound
   * session's snapshot and the account-wide scan are observed independently
   * — so the pair kept is (earliest, latest) by snapshot time, not by call
   * order. A new `resets_at` is a new window and discards the old points.
   */
  observe(
    limits: RateLimitSnapshot | null | undefined,
    observedAt: Date | null | undefined
  ): void {
    const window = limits?.primary;
    const usedPercent = window?.used_percent;
    const resetsAt = window?.resets_at;
    const atMs = observedAt?.getTime();
    if (
      usedPercent === undefined ||
      !Number.isFinite(usedPercent) ||
      resetsAt === undefined ||
      !Number.isFinite(resetsAt) ||
      atMs === undefined ||
      !Number.isFinite(atMs)
    ) {
      return;
    }

    if (this.resetsAt !== resetsAt) {
      this.resetsAt = resetsAt;
      this.first = null;
      this.latest = null;
    }

    const point: TrendPoint = { usedPercent, atMs };
    if (!this.first || atMs < this.first.atMs) {
      this.first = point;
    }
    if (!this.latest || atMs > this.latest.atMs) {
      this.latest = point;
    }
  }

  /**
   * Extrapolate the exhaustion moment for the window `limits` currently
   * reports, or null when there is nothing sound to say: a different window
   * than the tracked one, a baseline still too short, or no burn at all
   * (usage within one window only ever grows, so a flat or negative slope is
   * silence, not a forecast of "never").
   */
  project(limits: RateLimitSnapshot | null | undefined): QuotaProjection | null {
    const window = limits?.primary;
    if (
      !window ||
      window.resets_at === undefined ||
      window.resets_at !== this.resetsAt ||
      !this.first ||
      !this.latest
    ) {
      return null;
    }
    const spanMs = this.latest.atMs - this.first.atMs;
    if (spanMs < MIN_BASELINE_MS) {
      return null;
    }
    const burnedPercent = this.latest.usedPercent - this.first.usedPercent;
    if (burnedPercent <= 0) {
      return null;
    }
    const msPerPercent = spanMs / burnedPercent;
    return {
      exhaustsAtMs:
        this.latest.atMs + (100 - this.latest.usedPercent) * msPerPercent,
    };
  }
}
