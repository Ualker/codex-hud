/**
 * Small per-user snapshot files that let several HUD processes share one
 * collector's answer.
 *
 * Two or three HUDs open in the same directory each scanned the account
 * quota (255ms of tail reads a minute) and ran `git status` on the same
 * repository, one spawn per HUD per cadence. The answer is the same for all
 * of them, so whichever refreshes first writes it here and the others read
 * it while it is fresh. Same directory and atomic write as quota-trend.json;
 * every failure degrades to collecting locally.
 */

import { readPrivateState, resolveHudStateFile, writePrivateState } from './state-dir.js';

interface SharedEnvelope {
  writtenAt: number;
  value: unknown;
}

function sharedPath(name: string): string | null {
  return resolveHudStateFile(`shared-${name}.json`);
}

/**
 * The shared value when one was written within `maxAgeMs`, else null. The
 * envelope carries its own timestamp so a stale file from a dead HUD is never
 * served: mtime would do the same, but a copied or restored file would not.
 */
export function readSharedSnapshot<T>(
  name: string,
  maxAgeMs: number,
  revive: (raw: unknown) => T | null,
  nowMs: number = Date.now()
): T | null {
  const filePath = sharedPath(name);
  if (!filePath) {
    return null;
  }
  try {
    const parsed = JSON.parse(readPrivateState(filePath)) as SharedEnvelope;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.writtenAt !== 'number' ||
      !Number.isFinite(parsed.writtenAt) ||
      nowMs - parsed.writtenAt > maxAgeMs ||
      parsed.writtenAt > nowMs + 60_000
    ) {
      return null;
    }
    return revive(parsed.value);
  } catch {
    return null;
  }
}

/** Write atomically (tmp + rename); a failure leaves no partial file behind. */
export function writeSharedSnapshot(
  name: string,
  value: unknown,
  nowMs: number = Date.now()
): void {
  const filePath = sharedPath(name);
  if (!filePath) {
    return;
  }
  try {
    writePrivateState(
      filePath,
      JSON.stringify({ writtenAt: nowMs, value } satisfies SharedEnvelope)
    );
  } catch {
    // An unavailable cache never prevents collecting locally.
  }
}
