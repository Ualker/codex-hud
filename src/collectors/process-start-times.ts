import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startProbe } from '../utils/probe-latency.js';
import { getCodexDataNamespace } from '../utils/codex-path.js';
import { readSharedSnapshot, writeSharedSnapshot } from '../utils/shared-snapshot.js';
import { isProcessAlive } from './codex-liveness.js';
const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 8000;

type StartFact = [pid: string, startedAt: number, checkedAt: number];
function reviveStarts(raw: unknown): StartFact[] | null {
  return Array.isArray(raw) && raw.length <= 512 && raw.every(row =>
    Array.isArray(row) && row.length === 3 && /^\d+$/.test(row[0]) &&
    Number.isFinite(row[1]) && Number.isFinite(row[2])) ? raw : null;
}

/** Boot time from /proc/stat (Linux); null elsewhere. */
function readBootTimeSeconds(): number | null {
  try {
    const match = /^btime\s+(\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8'));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Process start times in epoch ms. Linux reads /proc (no spawn; starttime is
 * in USER_HZ=100 ticks); elsewhere one `ps -o lstart=` call (1s resolution).
 * Exited or unreadable processes are simply missing from the result.
 */
export async function getProcessStartTimesMs(pids: readonly string[]): Promise<Map<string, number>> {
  const starts = new Map<string, number>();
  const valid = [...new Set(pids)].filter((pid) => /^\d+$/.test(pid));
  if (valid.length === 0) {
    return starts;
  }

  const bootSeconds = readBootTimeSeconds();
  if (bootSeconds !== null) {
    for (const pid of valid) {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
        if (Number.isFinite(ticks)) {
          starts.set(pid, (bootSeconds + ticks / 100) * 1000);
        }
      } catch {
        // exited between the table walk and now
      }
    }
    return starts;
  }

  // No command lines or hook arguments are persisted: only PID/birth-time
  // facts, shared briefly across panes in the same account. /proc stays local.
  const cacheKey = `process-starts-${getCodexDataNamespace()}`;
  const now = Date.now();
  const cached = (readSharedSnapshot(cacheKey, 750, reviveStarts) ?? [])
    .filter(row => now - row[2] <= 750 && row[2] <= now);
  for (const [pid, at] of cached) {
    if (valid.includes(pid) && isProcessAlive(pid)) starts.set(pid, at);
  }
  const missing = valid.filter(pid => !starts.has(pid));
  if (missing.length === 0) return starts;

  const finishProbe = startProbe('ps');
  try {
    // lstart is localized ("三  9月/23 20:10:02 2026" under zh_CN); only the C
    // locale's "Wed Sep 23 20:10:02 2026" is something Date.parse reads.
    const { stdout } = await execFileAsync('ps', ['-o', 'pid=,lstart=', '-p', missing.join(',')], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\S.*\S)\s*$/.exec(line);
      const parsed = match ? Date.parse(match[2]) : Number.NaN;
      if (match && Number.isFinite(parsed)) {
        starts.set(match[1], parsed);
      }
    }
  } catch {
    // no start times: the connect-line pairing still works
  } finally {
    finishProbe();
  }
  if (starts.size > 0) {
    const merged = new Map(cached.map(row => [row[0], row]));
    // Reusing another HUD's fact must not renew its original deadline.
    for (const pid of missing) {
      const at = starts.get(pid);
      if (at !== undefined) merged.set(pid, [pid, at, Date.now()]);
    }
    writeSharedSnapshot(cacheKey, [...merged.values()].slice(-512));
  }
  return starts;
}
