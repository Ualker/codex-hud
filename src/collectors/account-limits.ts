/**
 * Account-level rate limits.
 *
 * Rate limits belong to the account, but they only reach the HUD through the
 * bound rollout's last `token_count` record. A HUD bound to a session that has
 * been idle for hours therefore reports whatever that session last happened to
 * see. Measured live on one account: two open sessions carried 9% and 84%
 * while the freshest snapshot on the machine said 27% — and every one of those
 * three records named the same window (`resets_at` 2026-08-18), so they were
 * three readings of one number, not three different limits.
 *
 * Because the display threshold is 70%, a stale low reading does not merely
 * look wrong: it withholds the warning entirely. So the newest snapshot any
 * session on this machine wrote is read directly and preferred whenever it is
 * newer than the bound session's own.
 */

import * as fs from 'fs';

import type { RateLimitSnapshot } from '../types.js';
import { findActiveRollouts } from './session-finder.js';
import { readCompleteJsonl } from '../utils/jsonl-tail.js';

/**
 * How far back to look for a snapshot. The primary window Codex reports is
 * weekly, so a snapshot older than that describes a window that has already
 * reset and is worthless; scanning further back only costs I/O.
 */
const LOOKBACK_DAYS = 8;
const LOOKBACK_SECONDS = LOOKBACK_DAYS * 24 * 60 * 60;

/**
 * Rollouts to open per batch, newest first. Rate limits are rewritten on
 * every turn, so the newest few files usually hold every snapshot worth
 * having — but "usually" broke during a real exhaustion window: once the
 * weekly limit is spent, every new session's first turn writes only a
 * degenerate snapshot (no windows, zero credits), and each of those files is
 * newer than the last informative reading. A fixed six-file budget would have
 * pushed the one snapshot that still stated `resets_at` out of reach after
 * six new sessions; three had accumulated within two days when this was
 * measured. The walk therefore continues past a batch that said nothing.
 */
const SCAN_BATCH_FILES = 6;

/**
 * Hard cap on files opened in one scan. Only reached when many consecutive
 * rollouts carry no informative snapshot; each costs one bounded tail read.
 */
const MAX_FILES_SEARCHED = 24;

/**
 * Bytes to read from the end of each rollout. `token_count` records are small
 * and arrive at the end of every turn, so the tail almost always contains
 * several. A file whose tail holds none simply does not contribute.
 */
const TAIL_BYTES = 256 * 1024;

export interface AccountRateLimits {
  limits: RateLimitSnapshot;
  /** When the session that wrote this snapshot observed it. */
  observedAt: Date;
}

interface RolloutRecord {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    rate_limits?: RateLimitSnapshot;
  };
}

function parseTimestamp(raw: string | undefined): Date | null {
  if (!raw) {
    return null;
  }
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Whether a snapshot states anything the quota row could render.
 *
 * Codex 0.147 can write a degenerate snapshot: observed live, the first turn
 * after the weekly window was exhausted recorded `limit_id:"premium"` with
 * both windows null and zero credits. It was the newest snapshot on the
 * machine, so "newest wins" put it in front of every informative reading and
 * the quota row went dark at 100% used — the one moment it matters most.
 * A snapshot with no window percentages and no reached flag must never shadow
 * one that has them.
 */
export function hasRateLimitSignal(limits: RateLimitSnapshot): boolean {
  if (
    limits.primary?.used_percent !== undefined ||
    limits.secondary?.used_percent !== undefined
  ) {
    return true;
  }
  return (
    Boolean(limits.rate_limit_reached_type) ||
    limits.spend_control_reached === true
  );
}

/** The last rate-limit snapshot in one rollout's tail, if it has one. */
async function readTailSnapshot(
  rolloutPath: string
): Promise<AccountRateLimits | null> {
  let size: number;
  try {
    ({ size } = fs.statSync(rolloutPath));
  } catch {
    return null;
  }

  let records: RolloutRecord[];
  try {
    const batch = await readCompleteJsonl<RolloutRecord>(
      rolloutPath,
      Math.max(0, size - TAIL_BYTES),
      { skipMalformed: true, alignToLineStart: size > TAIL_BYTES }
    );
    records = batch.records;
  } catch {
    return null;
  }

  // Walk backwards: the last snapshot in the file is the newest one it has.
  // Degenerate snapshots keep the walk going — behind the windowless record a
  // turn writes once the weekly limit is spent sits the reading that said so.
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    const payload = record?.payload;
    if (!payload?.rate_limits) {
      continue;
    }
    if (payload.type !== 'token_count' && payload.type !== 'rate_limit') {
      continue;
    }
    if (!hasRateLimitSignal(payload.rate_limits)) {
      continue;
    }
    const observedAt = parseTimestamp(record.timestamp);
    if (!observedAt) {
      continue;
    }
    return { limits: payload.rate_limits, observedAt };
  }
  return null;
}

/**
 * The newest rate-limit snapshot written by any Codex session on this machine.
 */
export async function findLatestAccountRateLimits(): Promise<AccountRateLimits | null> {
  let candidates;
  try {
    candidates = findActiveRollouts(
      LOOKBACK_SECONDS,
      undefined,
      LOOKBACK_DAYS
    ).slice(0, MAX_FILES_SEARCHED);
  } catch {
    return null;
  }

  let newest: AccountRateLimits | null = null;
  for (let start = 0; start < candidates.length; start += SCAN_BATCH_FILES) {
    // Candidates are mtime-descending and a record cannot be newer than its
    // file's mtime, so once the snapshot in hand outdates every remaining
    // file, no further read can improve on it. In the common case the newest
    // file holds the newest reading and the scan still stops after one batch.
    if (
      newest &&
      candidates[start].modifiedAt.getTime() <= newest.observedAt.getTime()
    ) {
      break;
    }
    const batch = candidates.slice(start, start + SCAN_BATCH_FILES);
    const snapshots = await Promise.all(
      batch.map((candidate) => readTailSnapshot(candidate.path))
    );
    for (const snapshot of snapshots) {
      if (!snapshot) {
        continue;
      }
      if (
        !newest ||
        snapshot.observedAt.getTime() > newest.observedAt.getTime()
      ) {
        newest = snapshot;
      }
    }
  }
  return newest;
}

/**
 * Choose between the bound session's snapshot and the account-wide one.
 *
 * Newest wins, with two guards. A snapshot from a different `limit_id` never
 * substitutes for the bound session's — but only when both actually carry a
 * reading: one account writes several limit_ids (observed live: "codex" for
 * the weekly window, "premium" for the credit pool), so the id separates
 * pools, not accounts, and a windowless snapshot has nothing the informative
 * one could contradict. And when both name the same window, the account-wide
 * reading is used even if it is only marginally newer, because `used_percent`
 * within one window only ever grows: the newer reading is never the more
 * optimistic mistake.
 */
export function preferFreshestRateLimits(
  sessionLimits: RateLimitSnapshot | null | undefined,
  sessionObservedAt: Date | null | undefined,
  account: AccountRateLimits | null | undefined
): RateLimitSnapshot | undefined {
  if (!account) {
    return sessionLimits ?? undefined;
  }
  if (!sessionLimits) {
    return account.limits;
  }
  const sessionInformative = hasRateLimitSignal(sessionLimits);
  const accountInformative = hasRateLimitSignal(account.limits);
  if (sessionInformative !== accountInformative) {
    return sessionInformative ? sessionLimits : account.limits;
  }
  const sessionLimitId = sessionLimits.limit_id;
  const accountLimitId = account.limits.limit_id;
  if (
    sessionLimitId !== undefined &&
    accountLimitId !== undefined &&
    sessionLimitId !== accountLimitId
  ) {
    return sessionLimits;
  }
  const sessionAt = sessionObservedAt?.getTime() ?? 0;
  return account.observedAt.getTime() >= sessionAt
    ? account.limits
    : sessionLimits;
}
