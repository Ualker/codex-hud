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
 * Rollouts to open, newest first. Rate limits are rewritten on every turn, so
 * the newest few files hold every snapshot worth having; opening more only
 * finds older readings of the same number.
 */
const MAX_FILES = 6;

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
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    const payload = record?.payload;
    if (!payload?.rate_limits) {
      continue;
    }
    if (payload.type !== 'token_count' && payload.type !== 'rate_limit') {
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
    ).slice(0, MAX_FILES);
  } catch {
    return null;
  }

  const snapshots = await Promise.all(
    candidates.map((candidate) => readTailSnapshot(candidate.path))
  );

  let newest: AccountRateLimits | null = null;
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
  return newest;
}

/**
 * Choose between the bound session's snapshot and the account-wide one.
 *
 * Newest wins, with two guards. A snapshot from a different `limit_id` is a
 * different account and never substitutes for the bound session's. And when
 * both name the same window, the account-wide reading is used even if it is
 * only marginally newer, because `used_percent` within one window only ever
 * grows: the newer reading is never the more optimistic mistake.
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
