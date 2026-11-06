import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { resolveHudStateFile } from './state-dir.js';
import { logHudError } from './hud-log.js';

/** One delivery attempt per account window and destination, across HUD processes. */
export function claimQuotaNotification(scope: string, command: string, nowMs: number): boolean {
  const key = createHash('sha256').update(JSON.stringify([scope, command])).digest('hex');
  const file = resolveHudStateFile(`quota-notify-${key}.json`);
  if (!file) return true; // Local transition/cooldown still works without writable state.
  try {
    fs.writeFileSync(file, JSON.stringify({ at: nowMs }), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    logHudError('quota-notify', error);
    return true;
  }
}
