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
 * State is two points — the earliest and the latest reading of the current
 * window — shared across HUDs through a small per-user state file. The quota
 * is account state, and with each process keeping only its own baseline two
 * panes forecast the same account differently: measured live, one said
 * `empty ~08/23` while its neighbour said `empty in 21h30m`, because the
 * slope is dominated by whichever first point each process happened to catch.
 * The file also survives `--reload`, which used to reset the baseline to
 * nothing for half an hour. Every filesystem failure degrades silently to
 * the in-process pair.
 */

import * as fs from 'fs';

import type { RateLimitSnapshot } from '../types.js';

export interface QuotaProjection {
  /** When the primary window reaches 100% at the observed pace. */
  exhaustsAtMs: number;
}

interface TrendPoint {
  usedPercent: number;
  atMs: number;
}

interface PersistedTrend {
  resetsAt: number;
  first: TrendPoint;
  latest: TrendPoint;
}

/**
 * Shortest baseline worth extrapolating. Right after a restart the two
 * points sit minutes apart, where one busy turn reads as a furious burn rate
 * and projects an exhaustion hours away; half an hour of separation damps
 * that without meaningfully delaying the signal on the day scale it serves.
 */
const MIN_BASELINE_MS = 30 * 60_000;

/**
 * How often project() re-reads the state file. An idle HUD never writes, so
 * without a periodic read it would keep its own baseline forever and never
 * converge with the pane that is actually burning quota.
 */
const RELOAD_INTERVAL_MS = 60_000;

function isValidPoint(value: unknown): value is TrendPoint {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const point = value as Record<string, unknown>;
  return (
    typeof point.usedPercent === 'number' &&
    Number.isFinite(point.usedPercent) &&
    typeof point.atMs === 'number' &&
    Number.isFinite(point.atMs)
  );
}

function parsePersisted(raw: string): PersistedTrend | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.resetsAt !== 'number' ||
      !Number.isFinite(record.resetsAt) ||
      !isValidPoint(record.first) ||
      !isValidPoint(record.latest)
    ) {
      return null;
    }
    return {
      resetsAt: record.resetsAt,
      first: record.first,
      latest: record.latest,
    };
  } catch {
    // A truncated or hand-edited file is no baseline at all.
    return null;
  }
}

export interface QuotaTrendOptions {
  /**
   * Where the shared baseline lives. Omit (or pass null) for in-memory-only
   * tracking — the default keeps unit tests and ad-hoc constructions away
   * from the real per-user state; the HUD entry point passes the resolved
   * path explicitly.
   */
  stateFilePath?: string | null;
}

export class QuotaTrendTracker {
  private readonly stateFilePath: string | null;
  private resetsAt: number | null = null;
  private first: TrendPoint | null = null;
  private latest: TrendPoint | null = null;
  private loaded = false;
  private lastReloadMs = 0;

  constructor(options: QuotaTrendOptions = {}) {
    this.stateFilePath = options.stateFilePath ?? null;
  }

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

    this.ensureLoaded();

    if (this.resetsAt !== resetsAt) {
      // A window the tracker has not seen may still be older than the one it
      // has (a stale rollout replayed late); points from a finished window
      // must never displace the live one.
      if (this.resetsAt !== null && resetsAt < this.resetsAt) {
        return;
      }
      this.resetsAt = resetsAt;
      this.first = null;
      this.latest = null;
    }

    const point: TrendPoint = { usedPercent, atMs };
    let changed = false;
    if (!this.first || atMs < this.first.atMs) {
      this.first = point;
      changed = true;
    }
    if (!this.latest || atMs > this.latest.atMs) {
      this.latest = point;
      changed = true;
    }
    if (changed) {
      this.syncToDisk();
    }
  }

  /**
   * Extrapolate the exhaustion moment for the window `limits` currently
   * reports, or null when there is nothing sound to say: a different window
   * than the tracked one, a baseline still too short, or no burn at all
   * (usage within one window only ever grows, so a flat or negative slope is
   * silence, not a forecast of "never").
   */
  project(
    limits: RateLimitSnapshot | null | undefined,
    nowMs: number = Date.now()
  ): QuotaProjection | null {
    this.ensureLoaded();
    this.maybeReload(nowMs);
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

  /** First touch adopts whatever baseline another HUD already persisted. */
  private ensureLoaded(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    this.mergeFromDisk();
  }

  private maybeReload(nowMs: number): void {
    if (
      !this.stateFilePath ||
      nowMs - this.lastReloadMs < RELOAD_INTERVAL_MS
    ) {
      return;
    }
    this.lastReloadMs = nowMs;
    this.mergeFromDisk();
  }

  /**
   * Fold the persisted pair into memory. A newer window on disk supersedes
   * the in-memory points (they describe a finished window); the same window
   * widens the pair to the earliest first and latest latest.
   */
  private mergeFromDisk(): void {
    if (!this.stateFilePath) {
      return;
    }
    let persisted: PersistedTrend | null = null;
    try {
      persisted = parsePersisted(
        fs.readFileSync(this.stateFilePath, 'utf8')
      );
    } catch {
      return;
    }
    if (!persisted) {
      return;
    }
    if (this.resetsAt === null || persisted.resetsAt > this.resetsAt) {
      this.resetsAt = persisted.resetsAt;
      this.first = persisted.first;
      this.latest = persisted.latest;
      return;
    }
    if (persisted.resetsAt !== this.resetsAt) {
      return;
    }
    if (!this.first || persisted.first.atMs < this.first.atMs) {
      this.first = persisted.first;
    }
    if (!this.latest || persisted.latest.atMs > this.latest.atMs) {
      this.latest = persisted.latest;
    }
  }

  /** Merge, then write atomically; a concurrent writer's points survive. */
  private syncToDisk(): void {
    if (!this.stateFilePath) {
      return;
    }
    this.mergeFromDisk();
    if (this.resetsAt === null || !this.first || !this.latest) {
      return;
    }
    const payload: PersistedTrend = {
      resetsAt: this.resetsAt,
      first: this.first,
      latest: this.latest,
    };
    const tempPath = `${this.stateFilePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(payload));
      fs.renameSync(tempPath, this.stateFilePath);
    } catch {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // Nothing left to clean.
      }
    }
  }
}
