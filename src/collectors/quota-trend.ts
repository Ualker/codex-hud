/**
 * Projected exhaustion of the rate-limit windows.
 *
 * The account's own history shows why a level gauge is not enough: measured
 * on this machine the weekly window burned ~24%/day and ran dry four days
 * before its reset, and the wall was hit both times with no warning beyond
 * the percentage itself. The snapshots to see it coming were all on disk —
 * each carries a timestamp — so two readings of one window give the slope,
 * and the slope says whether the money runs out before payday.
 *
 * Series are kept per window length. Codex 0.150 turned the single weekly
 * window into a 5h primary with the weekly demoted to secondary, and the
 * previous single-series tracker wedged on the switch: its stale-window
 * guard compared the incoming 5h `resets_at` against the stored weekly one
 * and rejected every new reading as a replay — measured live, four active
 * days added zero points while the file still held one point from before
 * the upgrade. Both windows are fixed blocks anchored at first use
 * (`resets_at` is stable within a block, with seconds of jitter at the
 * anchor at most), so within one class the rules hold: a larger `resets_at`
 * is a new block, a smaller one is a stale replay.
 *
 * State is two points per window — the earliest and the latest reading of
 * the current block — shared across HUDs through a small per-user state
 * file. The quota is account state, and with each process keeping only its
 * own baseline two panes forecast the same account differently: measured
 * live, one said `empty ~08/23` while its neighbour said `empty in 21h30m`,
 * because the slope is dominated by whichever first point each process
 * happened to catch. The file also survives `--reload`, which used to reset
 * the baseline to nothing for half an hour. Every filesystem failure
 * degrades silently to the in-process pairs.
 */

import * as fs from 'fs';

import type { RateLimitSnapshot, RateLimitWindow } from '../types.js';

export interface QuotaProjection {
  /** When the window reaches 100% at the observed pace. */
  exhaustsAtMs: number;
  /**
   * Span between the two readings behind the pace. The renderer trusts a
   * long baseline the way it trusts a half-spent window: measured live the
   * weekly window stood at 38% after 47 hours of readings, a pace that
   * emptied it a day and a half before its reset, and a percentage gate
   * alone kept that forecast off the row for another sixteen hours.
   */
  baselineMs: number;
}

interface TrendPoint {
  usedPercent: number;
  atMs: number;
}

interface WindowSeries {
  resetsAt: number;
  first: TrendPoint;
  latest: TrendPoint;
}

/**
 * Shortest baseline worth extrapolating. Right after a restart the two
 * points sit minutes apart, where one busy turn reads as a furious burn rate
 * and projects an exhaustion hours away; half an hour of separation damps
 * that without meaningfully delaying the signal on the scales it serves —
 * a tenth of the 5h window, a sliver of the weekly one.
 */
const MIN_BASELINE_MS = 30 * 60_000;

/**
 * How often project() re-reads the state file. An idle HUD never writes, so
 * without a periodic read it would keep its own baseline forever and never
 * converge with the pane that is actually burning quota.
 */
const RELOAD_INTERVAL_MS = 60_000;

/**
 * On-disk format version. The unversioned pre-0.150 file held exactly one
 * series and is exactly the wedged state the per-window split replaces, so
 * it is discarded rather than migrated — its one surviving point described
 * a window block that has long since finished.
 */
const PERSIST_VERSION = 2;

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

function parseSeries(value: unknown): WindowSeries | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
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
}

function parsePersisted(raw: string): Map<number, WindowSeries> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (record.version !== PERSIST_VERSION) {
      return null;
    }
    if (typeof record.windows !== 'object' || record.windows === null) {
      return null;
    }
    const series = new Map<number, WindowSeries>();
    for (const [key, value] of Object.entries(record.windows)) {
      const windowMinutes = Number(key);
      if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
        continue;
      }
      const parsedSeries = parseSeries(value);
      if (parsedSeries) {
        series.set(windowMinutes, parsedSeries);
      }
    }
    return series;
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
  private readonly series = new Map<number, WindowSeries>();
  private loaded = false;
  private lastReloadMs = 0;

  constructor(options: QuotaTrendOptions = {}) {
    this.stateFilePath = options.stateFilePath ?? null;
  }

  /**
   * Record one snapshot: every window in it feeds its own series.
   * Observations may arrive out of order — the bound session's snapshot and
   * the account-wide scan are observed independently — so the pair kept is
   * (earliest, latest) by snapshot time, not by call order. Within a window
   * class, a new `resets_at` is a new block and discards the old points.
   */
  observe(
    limits: RateLimitSnapshot | null | undefined,
    observedAt: Date | null | undefined
  ): void {
    const atMs = observedAt?.getTime();
    if (atMs === undefined || !Number.isFinite(atMs)) {
      return;
    }
    this.ensureLoaded();
    let changed = false;
    for (const window of [limits?.primary, limits?.secondary]) {
      if (this.observeWindow(window, atMs)) {
        changed = true;
      }
    }
    if (changed) {
      this.syncToDisk();
    }
  }

  private observeWindow(
    window: RateLimitWindow | null | undefined,
    atMs: number
  ): boolean {
    const usedPercent = window?.used_percent;
    const resetsAt = window?.resets_at;
    const windowMinutes = window?.window_minutes;
    if (
      usedPercent === undefined ||
      !Number.isFinite(usedPercent) ||
      resetsAt === undefined ||
      !Number.isFinite(resetsAt) ||
      windowMinutes === undefined ||
      !Number.isFinite(windowMinutes) ||
      windowMinutes <= 0
    ) {
      return false;
    }

    const existing = this.series.get(windowMinutes);
    const point: TrendPoint = { usedPercent, atMs };
    if (!existing || existing.resetsAt !== resetsAt) {
      // A window this class has not seen may still be older than the one it
      // has (a stale rollout replayed late); points from a finished block
      // must never displace the live one. The comparison stays inside the
      // class: the 5h and weekly blocks end at moments that say nothing
      // about each other.
      if (existing && resetsAt < existing.resetsAt) {
        return false;
      }
      this.series.set(windowMinutes, {
        resetsAt,
        first: point,
        latest: point,
      });
      return true;
    }

    let changed = false;
    if (atMs < existing.first.atMs) {
      existing.first = point;
      changed = true;
    }
    if (atMs > existing.latest.atMs) {
      existing.latest = point;
      changed = true;
    }
    return changed;
  }

  /**
   * Extrapolate the exhaustion moment for one window, or null when there is
   * nothing sound to say: a block other than the tracked one, a baseline
   * still too short, or no burn at all (usage within one block only ever
   * grows, so a flat or negative slope is silence, not a forecast of
   * "never").
   */
  projectWindow(
    window: RateLimitWindow | null | undefined,
    nowMs: number = Date.now()
  ): QuotaProjection | null {
    this.ensureLoaded();
    this.maybeReload(nowMs);
    const windowMinutes = window?.window_minutes;
    const resetsAt = window?.resets_at;
    if (
      windowMinutes === undefined ||
      !Number.isFinite(windowMinutes) ||
      resetsAt === undefined ||
      !Number.isFinite(resetsAt)
    ) {
      return null;
    }
    const series = this.series.get(windowMinutes);
    if (!series || series.resetsAt !== resetsAt) {
      return null;
    }
    const spanMs = series.latest.atMs - series.first.atMs;
    if (spanMs < MIN_BASELINE_MS) {
      return null;
    }
    const burnedPercent = series.latest.usedPercent - series.first.usedPercent;
    if (burnedPercent <= 0) {
      return null;
    }
    const msPerPercent = spanMs / burnedPercent;
    return {
      exhaustsAtMs:
        series.latest.atMs +
        (100 - series.latest.usedPercent) * msPerPercent,
      baselineMs: spanMs,
    };
  }

  /**
   * Every window the snapshot names, projected, keyed by `window_minutes` —
   * the display matches each shown window to its own forecast.
   */
  projectAll(
    limits: RateLimitSnapshot | null | undefined,
    nowMs: number = Date.now()
  ): Record<number, QuotaProjection> | null {
    const projections: Record<number, QuotaProjection> = {};
    let any = false;
    for (const window of [limits?.primary, limits?.secondary]) {
      const windowMinutes = window?.window_minutes;
      if (windowMinutes === undefined || !Number.isFinite(windowMinutes)) {
        continue;
      }
      const projection = this.projectWindow(window, nowMs);
      if (projection) {
        projections[windowMinutes] = projection;
        any = true;
      }
    }
    return any ? projections : null;
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
   * Fold the persisted series into memory, class by class. A newer block on
   * disk supersedes the in-memory points (they describe a finished block);
   * the same block widens the pair to the earliest first and latest latest.
   */
  private mergeFromDisk(): void {
    if (!this.stateFilePath) {
      return;
    }
    let persisted: Map<number, WindowSeries> | null = null;
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
    for (const [windowMinutes, incoming] of persisted) {
      const existing = this.series.get(windowMinutes);
      if (!existing || incoming.resetsAt > existing.resetsAt) {
        this.series.set(windowMinutes, { ...incoming });
        continue;
      }
      if (incoming.resetsAt !== existing.resetsAt) {
        continue;
      }
      if (incoming.first.atMs < existing.first.atMs) {
        existing.first = incoming.first;
      }
      if (incoming.latest.atMs > existing.latest.atMs) {
        existing.latest = incoming.latest;
      }
    }
  }

  /** Merge, then write atomically; a concurrent writer's points survive. */
  private syncToDisk(): void {
    if (!this.stateFilePath) {
      return;
    }
    this.mergeFromDisk();
    if (this.series.size === 0) {
      return;
    }
    const windows: Record<string, WindowSeries> = {};
    for (const [windowMinutes, series] of this.series) {
      windows[String(windowMinutes)] = series;
    }
    const payload = { version: PERSIST_VERSION, windows };
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
