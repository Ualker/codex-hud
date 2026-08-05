/**
 * Session finder for locating active/recent Codex session rollout files
 * Searches ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import { getCodexHome, getSessionsDir } from '../utils/codex-path.js';
import { extractCodexRuntimeHookState } from './runtime-hooks.js';
import type { SessionInfo } from '../types.js';

/**
 * Built-in sqlite (Node >= 22.5). Preferred over spawning the sqlite3 CLI:
 * the CLI is missing in minimal containers and process spawns can stall for
 * seconds on loaded machines. Falls back to the CLI on older Node versions.
 */
const nodeSqlite: { DatabaseSync: new (path: string, options: { readOnly: boolean }) => {
  prepare(sql: string): { all(): Record<string, unknown>[] };
  close(): void;
} } | null = (() => {
  const originalEmitWarning = process.emitWarning;
  // Importing node:sqlite raises an ExperimentalWarning on stderr, which
  // would leak into the HUD pane.
  process.emitWarning = (() => {}) as typeof process.emitWarning;
  try {
    return createRequire(import.meta.url)('node:sqlite');
  } catch {
    return null;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
})();

const DEFAULT_LOOKBACK_DAYS = 30;
const TARGET_START_TOLERANCE_MS = 10 * 60 * 1000;
const PANE_SNAPSHOT_STALE_TOLERANCE_MS = 30 * 1000;
const LAUNCH_ROLLOUT_BACKDATE_TOLERANCE_MS = 30 * 1000;

// Spawned probes (tmux/ps/sqlite3) can take multiple seconds on a loaded
// machine purely from process startup overhead; a tight timeout makes binding
// fail randomly.
const PROBE_TIMEOUT_MS = 8000;

// Probes run off the event loop; under load a spawn can take seconds and
// must never freeze the render loop (execFileSync did exactly that).
const execFileAsync = promisify(execFile);
// Full pane->thread resolution is expensive (subprocess spawns); throttle it so
// the 1s render loop reuses the cached binding.
const FULL_RESOLVE_INTERVAL_MS = 4000;
// While consecutive resolves keep returning the same session, the cadence
// backs off toward this cap; any change, force, or probe failure restores the
// base cadence. Bounded so a same-pane /new or /resume switch (no watcher
// event guaranteed) is still noticed promptly.
const FULL_RESOLVE_INTERVAL_MAX_MS = 12_000;
const FULL_RESOLVE_BACKOFF_FACTOR = 1.5;
// How far back to look for log rows tying a process to a thread.
const THREAD_CANDIDATE_WINDOW_MS = 24 * 60 * 60 * 1000;
// Candidates older than this relative to the newest one are ignored (guards
// against pid reuse picking up threads of a long-dead process).
const THREAD_ACTIVE_WINDOW_MS = 60 * 1000;
// A confirmed thread must out-log the bound thread by this margin before the
// HUD rebinds (a /new or /resume switch, not interleaved concurrent logging).
const THREAD_SWITCH_MARGIN_MS = 10 * 1000;
const MAX_THREAD_CANDIDATES = 8;
// How long a "nothing known yet" verdict for a thread is trusted before
// re-querying. Kept short so a /new session is promoted quickly once its
// rollout file / state row lands; noteRolloutAppeared() bypasses it entirely.
const THREAD_FACTS_NEGATIVE_TTL_MS = 5 * 1000;

export interface SessionFile {
  path: string;
  sessionId: string;
  timestamp: Date;
  size: number;
  modifiedAt: Date;
  metadata?: SessionInfo;
}

interface PaneSnapshot {
  threadId: string;
  nonce: bigint;
  path: string;
  timestamp: Date | null;
}

export { getCodexHome, getSessionsDir };

const SHELL_SNAPSHOTS_SUBDIR = 'shell_snapshots';
const ARCHIVED_SESSIONS_SUBDIR = 'archived_sessions';
const LOG_SESSION_PATH_PREFIX = 'codex-log://';

function normalizePath(input?: string | null): string | null {
  if (!input) {
    return null;
  }

  try {
    return fs.realpathSync(input);
  } catch {
    return path.resolve(input);
  }
}

/**
 * Peek at the first line of a rollout file to get its CWD
 */
function readFirstLine(filePath: string, maxBytes: number = 1024 * 1024): string | null {
  const fd = fs.openSync(filePath, 'r');
  try {
    const bufferSize = 4096;
    const buffer = Buffer.alloc(bufferSize);
    let bytesReadTotal = 0;
    let line = '';

    while (bytesReadTotal < maxBytes) {
      const bytesRead = fs.readSync(fd, buffer, 0, bufferSize, bytesReadTotal);
      if (bytesRead <= 0) {
        break;
      }
      bytesReadTotal += bytesRead;

      const chunk = buffer.toString('utf8', 0, bytesRead);
      const newlineIndex = chunk.indexOf('\n');
      if (newlineIndex !== -1) {
        line += chunk.slice(0, newlineIndex);
        return line;
      }

      line += chunk;
    }

    if (bytesReadTotal >= maxBytes) {
      throw new Error(`Rollout first line exceeds ${maxBytes} bytes: ${filePath}`);
    }

    return line.length > 0 ? line : null;
  } finally {
    fs.closeSync(fd);
  }
}

interface RolloutCwdCacheEntry {
  cwd: string | null;
  size: number;
}

// A rollout's first line (session_meta) is written once and never rewritten,
// so a resolved cwd is cached permanently by path. Unresolved entries are
// re-read only after the file has grown, which covers a first line that was
// still being written. Without this cache every fallback scan re-opens every
// rollout file in the lookback window.
const rolloutCwdCache = new Map<string, RolloutCwdCacheEntry>();
const ROLLOUT_CWD_CACHE_LIMIT = 8192;

function peekRolloutCwd(filePath: string): string | null {
  const cached = rolloutCwdCache.get(filePath);
  if (cached && cached.cwd !== null) {
    return cached.cwd;
  }

  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    rolloutCwdCache.delete(filePath);
    return null;
  }
  if (cached && cached.size === size) {
    return null;
  }

  let cwd: string | null = null;
  try {
    const firstLine = readFirstLine(filePath);
    if (firstLine) {
      const entry = JSON.parse(firstLine.trim());
      if (entry.type === 'session_meta' && entry.payload) {
        cwd = normalizePath(entry.payload.cwd);
      }
    }
  } catch {
    // Ignore errors or malformed files
  }

  if (rolloutCwdCache.size >= ROLLOUT_CWD_CACHE_LIMIT) {
    rolloutCwdCache.clear();
  }
  rolloutCwdCache.set(filePath, { cwd, size });
  return cwd;
}

/**
 * Parse a rollout filename to extract timestamp and session ID
 * Format: rollout-YYYY-MM-DDTHH-MM-SS-<session-id>.jsonl
 */
function parseRolloutFilename(filename: string): { timestamp: Date; sessionId: string } | null {
  // Match pattern: rollout-2026-01-15T17-47-44-019bc10d-c89d-7352-935c-76b351384357.jsonl
  const match = filename.match(
    /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([a-f0-9-]+)\.jsonl$/
  );

  if (!match) {
    return null;
  }

  // Parse timestamp: 2026-01-15T17-47-44 -> 2026-01-15T17:47:44
  const timestampStr = match[1].replace(/-(\d{2})-(\d{2})$/, ':$1:$2');
  const timestamp = new Date(timestampStr);

  if (isNaN(timestamp.getTime())) {
    return null;
  }

  return {
    timestamp,
    sessionId: match[2],
  };
}

/**
 * Find all rollout files in a date directory
 */
function findRolloutsInDir(dirPath: string): SessionFile[] {
  const results: SessionFile[] = [];

  if (!fs.existsSync(dirPath)) {
    return results;
  }

  try {
    const files = fs.readdirSync(dirPath);

    for (const file of files) {
      if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) {
        continue;
      }

      const parsed = parseRolloutFilename(file);
      if (!parsed) {
        continue;
      }

      const fullPath = path.join(dirPath, file);
      try {
        const stats = fs.statSync(fullPath);
        results.push({
          path: fullPath,
          sessionId: parsed.sessionId,
          timestamp: parsed.timestamp,
          size: stats.size,
          modifiedAt: stats.mtime,
        });
      } catch {
        // Skip files we cannot stat
      }
    }
  } catch {
    // Directory read error
  }

  return results;
}

/**
 * Find all rollout files within the last N days
 */
function findRolloutsInDays(maxDaysBack: number = DEFAULT_LOOKBACK_DAYS): SessionFile[] {
  const sessionsDir = getSessionsDir();
  const now = new Date();
  const rollouts: SessionFile[] = [];

  for (let daysAgo = 0; daysAgo <= maxDaysBack; daysAgo++) {
    const date = new Date(now);
    date.setDate(date.getDate() - daysAgo);

    const year = date.getFullYear().toString();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');

    const dayDir = path.join(sessionsDir, year, month, day);
    rollouts.push(...findRolloutsInDir(dayDir));
  }

  return rollouts;
}

/**
 * Find the most recent rollout file
 * Searches backwards from today's date
 */
export function findMostRecentRollout(
  maxDaysBack: number = DEFAULT_LOOKBACK_DAYS,
  targetCwd?: string
): SessionFile | null {
  const normalizedTarget = normalizePath(targetCwd);
  const sessionsDir = getSessionsDir();

  if (!fs.existsSync(sessionsDir)) {
    return null;
  }

  const now = new Date();
  let allSessions: SessionFile[] = [];

  // Search backwards from today
  for (let daysAgo = 0; daysAgo <= maxDaysBack; daysAgo++) {
    const date = new Date(now);
    date.setDate(date.getDate() - daysAgo);

    const year = date.getFullYear().toString();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');

    const dayDir = path.join(sessionsDir, year, month, day);
    const rolloutsInDay = findRolloutsInDir(dayDir);
    
    // Filter by CWD if provided
    let sessions = rolloutsInDay;
    if (normalizedTarget) {
      sessions = sessions.filter(r => peekRolloutCwd(r.path) === normalizedTarget);
    }
    
    allSessions = allSessions.concat(sessions);
    
  }

  if (allSessions.length === 0) {
    return null;
  }

  // Sort by modification time (most recent first)
  allSessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());

  return allSessions[0];
}

/**
 * Find rollout files modified within the last N seconds
 * Useful for finding actively-used sessions
 */
export function findActiveRollouts(
  withinSeconds: number = 60,
  targetCwd?: string,
  maxDaysBack: number = DEFAULT_LOOKBACK_DAYS
): SessionFile[] {
  const normalizedTarget = normalizePath(targetCwd);
  const sessionsDir = getSessionsDir();

  if (!fs.existsSync(sessionsDir)) {
    return [];
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - withinSeconds * 1000);

  let rollouts: SessionFile[] = [];
  for (let daysAgo = 0; daysAgo <= maxDaysBack; daysAgo++) {
    const date = new Date(now);
    date.setDate(date.getDate() - daysAgo);

    const year = date.getFullYear().toString();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');

    const dayDir = path.join(sessionsDir, year, month, day);
    rollouts = rollouts.concat(findRolloutsInDir(dayDir));
  }

  // Filter to recently modified and CWD
  return rollouts
    .filter((r) => {
      if (r.modifiedAt < cutoff) return false;
      if (normalizedTarget && peekRolloutCwd(r.path) !== normalizedTarget) return false;
      return true;
    })
    .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

/**
 * Find an active session (convenience wrapper)
 * Returns the path to the most recently modified rollout file
 */
export async function findActiveSession(targetCwd?: string): Promise<string | null> {
  const active = findActiveRollouts(60, targetCwd, DEFAULT_LOOKBACK_DAYS);
  if (active.length > 0) {
    return active[0].path;
  }
  
  const recent = findMostRecentRollout(DEFAULT_LOOKBACK_DAYS, targetCwd);
  return recent?.path ?? null;
}

/**
 * Find a rollout file by session ID
 */
export function findRolloutBySessionId(
  sessionId: string,
  maxDaysBack: number = 7
): SessionFile | null {
  const sessionsDir = getSessionsDir();

  if (!fs.existsSync(sessionsDir)) {
    return null;
  }

  const now = new Date();

  // Search backwards from today
  for (let daysAgo = 0; daysAgo <= maxDaysBack; daysAgo++) {
    const date = new Date(now);
    date.setDate(date.getDate() - daysAgo);

    const year = date.getFullYear().toString();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');

    const dayDir = path.join(sessionsDir, year, month, day);
    const rolloutsInDay = findRolloutsInDir(dayDir);

    const match = rolloutsInDay.find((r) => r.sessionId === sessionId);
    if (match) {
      return match;
    }
  }

  return null;
}

function parseSnapshotFilename(filename: string): { threadId: string; nonce: bigint } | null {
  const match = filename.match(/^([a-f0-9-]+)\.(\d+)\.[^.]+$/);
  if (!match) {
    return null;
  }

  try {
    return {
      threadId: match[1],
      nonce: BigInt(match[2]),
    };
  } catch {
    return null;
  }
}

function readSnapshotPane(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    // Shell snapshots export TMUX_PANE in several forms depending on the shell:
    // bare/export assignments plus declare/typeset flag sets containing `x`.
    // Non-exported locals and same-suffix decoys must not bind the HUD.
    const match = content.match(
      /(?:^|\n)(?:(?:export|(?:declare|typeset)\s+-[a-zA-Z]*x[a-zA-Z]*)\s+)?TMUX_PANE=(?:'([^']*)'|"([^"]*)"|([^\n]+))/
    );
    const pane = match?.[1] ?? match?.[2] ?? match?.[3];
    return pane ? pane.trim() : null;
  } catch {
    return null;
  }
}

function snapshotTimestampFromNonce(nonce: bigint): Date | null {
  const milliseconds = nonce / 1_000_000n;
  const timestamp = Number(milliseconds);
  const minReasonableTimestamp = Date.UTC(2020, 0, 1);
  const maxReasonableTimestamp = Date.UTC(2100, 0, 1);

  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < minReasonableTimestamp ||
    timestamp > maxReasonableTimestamp
  ) {
    return null;
  }

  return new Date(timestamp);
}

function findSnapshotForPane(mainPaneId: string): PaneSnapshot | null {
  const snapshotsDir = path.join(getCodexHome(), SHELL_SNAPSHOTS_SUBDIR);
  if (!fs.existsSync(snapshotsDir)) {
    return null;
  }

  const matches: PaneSnapshot[] = [];

  try {
    const files = fs.readdirSync(snapshotsDir);
    for (const file of files) {
      const parsed = parseSnapshotFilename(file);
      if (!parsed) {
        continue;
      }

      const filePath = path.join(snapshotsDir, file);
      if (readSnapshotPane(filePath) !== mainPaneId) {
        continue;
      }

      let timestamp = snapshotTimestampFromNonce(parsed.nonce);
      if (!timestamp) {
        try {
          timestamp = fs.statSync(filePath).mtime;
        } catch {
          timestamp = null;
        }
      }

      matches.push({
        threadId: parsed.threadId,
        nonce: parsed.nonce,
        path: filePath,
        timestamp,
      });
    }
  } catch {
    return null;
  }

  matches.sort((a, b) => {
    if (a.nonce === b.nonce) {
      return b.path.localeCompare(a.path);
    }
    return a.nonce > b.nonce ? -1 : 1;
  });

  return matches[0] ?? null;
}

/**
 * Latest possible instant covered by a YYYY[/MM[/DD]] directory prefix,
 * interpreted in local time (rollout paths use local dates).
 */
function latestMsForDatePrefix(parts: readonly number[]): number {
  const [year, month, day] = parts;
  if (parts.length === 1) {
    return new Date(year + 1, 0, 1).getTime();
  }
  if (parts.length === 2) {
    return new Date(year, month, 1).getTime();
  }
  return new Date(year, month - 1, day + 1).getTime();
}

function findRolloutPathBySessionIdInRoot(
  rootDir: string,
  sessionId: string,
  sinceMs?: number
): string | null {
  if (!fs.existsSync(rootDir)) {
    return null;
  }

  const expectedSuffix = `-${sessionId}.jsonl`;
  const stack: { dir: string; dateParts: number[] }[] = [
    { dir: rootDir, dateParts: [] },
  ];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) {
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(frame.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(frame.dir, entry.name);
      if (entry.isDirectory()) {
        // Prune date directories that end before the requested window; keep
        // non-date directories (defensive against layout changes).
        if (
          sinceMs !== undefined &&
          frame.dateParts.length < 3 &&
          /^\d{1,4}$/.test(entry.name)
        ) {
          const dateParts = [...frame.dateParts, Number(entry.name)];
          if (latestMsForDatePrefix(dateParts) < sinceMs) {
            continue;
          }
          stack.push({ dir: fullPath, dateParts });
          continue;
        }
        stack.push({ dir: fullPath, dateParts: frame.dateParts });
        continue;
      }

      if (
        entry.isFile() &&
        entry.name.startsWith('rollout-') &&
        entry.name.endsWith(expectedSuffix)
      ) {
        return fullPath;
      }
    }
  }

  return null;
}

function buildSessionFile(filePath: string): SessionFile | null {
  const parsed = parseRolloutFilename(path.basename(filePath));
  if (!parsed) {
    return null;
  }

  try {
    const stats = fs.statSync(filePath);
    return {
      path: filePath,
      sessionId: parsed.sessionId,
      timestamp: parsed.timestamp,
      size: stats.size,
      modifiedAt: stats.mtime,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve an exact rollout by Codex thread id across active and archived
 * sessions. This intentionally does not use the local sqlite/log fallback:
 * subagent lifecycle tracking needs a concrete JSONL file to tail.
 */
export function findRolloutByThreadId(
  threadId: string,
  sinceMs?: number
): SessionFile | null {
  const codexHome = getCodexHome();
  const activePath = findRolloutPathBySessionIdInRoot(
    path.join(codexHome, 'sessions'),
    threadId,
    sinceMs
  );
  if (activePath) {
    return buildSessionFile(activePath);
  }

  const archivedPath = findRolloutPathBySessionIdInRoot(
    path.join(codexHome, ARCHIVED_SESSIONS_SUBDIR),
    threadId,
    sinceMs
  );

  return archivedPath ? buildSessionFile(archivedPath) : null;
}

async function findSessionByThreadId(
  sessionId: string,
  targetCwd: string | null,
  knownRolloutPath?: string | null
): Promise<SessionFile | null> {
  if (knownRolloutPath && fs.existsSync(knownRolloutPath)) {
    const knownSession = buildSessionFile(knownRolloutPath);
    if (knownSession) {
      return knownSession;
    }
  }

  const rolloutSession = findRolloutByThreadId(sessionId);
  if (rolloutSession) {
    return rolloutSession;
  }

  return buildLogBackedSession(sessionId, targetCwd);
}

function isThreadId(value: string): boolean {
  return /^[a-f0-9-]+$/i.test(value);
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function getLogDatabaseCandidates(): string[] {
  const codexHome = getCodexHome();
  let entries: string[];

  try {
    entries = fs.readdirSync(codexHome);
  } catch {
    return [];
  }

  return entries
    .filter((entry) => /^logs(?:_\d+)?\.sqlite$/.test(entry))
    .map((entry) => path.join(codexHome, entry))
    .filter((entryPath) => {
      try {
        return fs.statSync(entryPath).isFile();
      } catch {
        return false;
      }
    })
    .sort((left, right) => {
      try {
        return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
      } catch {
        return right.localeCompare(left);
      }
    });
}

interface ReadOnlyDatabase {
  prepare(sql: string): { all(): Record<string, unknown>[] };
  close(): void;
}

// Probes run every few seconds; keep read-only handles open instead of
// paying open/close on each query. Rotated databases (logs_2 -> logs_3)
// leave stale entries behind, so a tiny cap closes everything before a new
// path is opened; query errors also drop the handle so the next probe
// reopens a fresh connection.
const openReadOnlyDatabases = new Map<string, ReadOnlyDatabase>();
const MAX_OPEN_DATABASES = 4;

function closeReadOnlyDatabase(dbPath: string): void {
  const cached = openReadOnlyDatabases.get(dbPath);
  if (!cached) {
    return;
  }
  openReadOnlyDatabases.delete(dbPath);
  try {
    cached.close();
  } catch {
    // Closing a broken handle must not break the probe.
  }
}

function getReadOnlyDatabase(dbPath: string): ReadOnlyDatabase | null {
  if (!nodeSqlite) {
    return null;
  }
  const cached = openReadOnlyDatabases.get(dbPath);
  if (cached) {
    return cached;
  }
  if (openReadOnlyDatabases.size >= MAX_OPEN_DATABASES) {
    for (const key of [...openReadOnlyDatabases.keys()]) {
      closeReadOnlyDatabase(key);
    }
  }
  const db = new nodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  openReadOnlyDatabases.set(dbPath, db);
  return db;
}

/**
 * Run read-only SQL statements and return rows in sqlite3-CLI text form:
 * one row per line, columns joined with \x1f, NULL as empty string.
 * Returns null when the query could not be executed (treated as transient).
 */
async function querySqlite(
  dbPath: string,
  statements: string[]
): Promise<string | null> {
  if (nodeSqlite) {
    try {
      const db = getReadOnlyDatabase(dbPath);
      if (!db) {
        return null;
      }
      const lines: string[] = [];
      for (const statement of statements) {
        for (const row of db.prepare(statement).all()) {
          lines.push(
            Object.values(row)
              .map((value) => (value === null || value === undefined ? '' : String(value)))
              .join('\x1f')
          );
        }
      }
      return lines.join('\n');
    } catch {
      closeReadOnlyDatabase(dbPath);
      return null;
    }
  }

  try {
    const { stdout } = await execFileAsync(
      'sqlite3',
      ['-readonly', '-separator', '\x1f', dbPath, statements.join(';\n') + ';'],
      {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
      }
    );
    return stdout.trimEnd();
  } catch {
    return null;
  }
}

function getStateDatabaseCandidates(): string[] {
  const codexHome = getCodexHome();
  let entries: string[];

  try {
    entries = fs.readdirSync(codexHome);
  } catch {
    return [];
  }

  return entries
    .filter((entry) => /^state(?:_\d+)?\.sqlite$/.test(entry))
    .map((entry) => path.join(codexHome, entry))
    .filter((entryPath) => {
      try {
        return fs.statSync(entryPath).isFile();
      } catch {
        return false;
      }
    })
    .sort((left, right) => {
      try {
        return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
      } catch {
        return right.localeCompare(left);
      }
    });
}

async function getPaneProcessId(mainPaneId: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'tmux',
      ['display', '-p', '-t', mainPaneId, '#{pane_pid}'],
      {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
      }
    );
    const output = stdout.trim();
    return /^\d+$/.test(output) ? output : null;
  } catch {
    return null;
  }
}

interface ProcessTreeSnapshot {
  processIds: string[];
  commands: string[];
}

async function getProcessTreeSnapshot(
  rootPid: string
): Promise<ProcessTreeSnapshot | null> {
  if (!/^\d+$/.test(rootPid)) {
    return { processIds: [], commands: [] };
  }

  let output: string;
  try {
    ({ stdout: output } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,command='], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    }));
  } catch {
    return null;
  }

  const childrenByParent = new Map<string, string[]>();
  const commandsByPid = new Map<string, string>();
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)(?:\s+(.*))?$/);
    if (!match) {
      continue;
    }

    const pid = match[1];
    const parentPid = match[2];
    commandsByPid.set(pid, match[3] ?? '');
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }

  const result: string[] = [];
  const seen = new Set<string>();
  const queue = [rootPid];

  while (queue.length > 0 && result.length < 32) {
    const pid = queue.shift();
    if (!pid || seen.has(pid)) {
      continue;
    }

    seen.add(pid);
    result.push(pid);
    queue.push(...(childrenByParent.get(pid) ?? []));
  }

  return {
    processIds: result,
    commands: result
      .map((pid) => commandsByPid.get(pid))
      .filter((command): command is string => Boolean(command)),
  };
}

function extractLogField(body: string, field: string): string | undefined {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = body.match(new RegExp(`(?:^|[\\s{])${escaped}=([^\\s}]+)`));
  return match?.[1];
}

async function buildLogBackedSession(
  threadId: string,
  targetCwd: string | null
): Promise<SessionFile | null> {
  if (!isThreadId(threadId)) {
    return null;
  }

  const escapedThreadId = escapeSqlString(threadId);
  const sql = `
SELECT
  COALESCE((SELECT min(ts) FROM logs WHERE thread_id = '${escapedThreadId}'), 0) AS first_ts,
  COALESCE((SELECT max(ts) FROM logs WHERE thread_id = '${escapedThreadId}'), 0) AS last_ts,
  COALESCE((
    SELECT replace(replace(feedback_log_body, char(10), ' '), char(13), ' ')
    FROM logs
    WHERE thread_id = '${escapedThreadId}' AND feedback_log_body IS NOT NULL
    ORDER BY ts DESC, ts_nanos DESC, id DESC
    LIMIT 1
  ), '') AS body
`.trim();

  for (const dbPath of getLogDatabaseCandidates()) {
    const output = await querySqlite(dbPath, [sql]);
    if (!output) {
      continue;
    }

    const [firstTsRaw, latestTsRaw, body = ''] = output.split('\x1f');
    const firstTs = Number(firstTsRaw);
    const latestTs = Number(latestTsRaw);
    if (!Number.isFinite(firstTs) || firstTs <= 0) {
      continue;
    }

    const startTime = new Date(firstTs * 1000);
    const modifiedAt = new Date((Number.isFinite(latestTs) && latestTs > 0 ? latestTs : firstTs) * 1000);
    const model = extractLogField(body, 'model');
    const reasoningEffort = extractLogField(body, 'codex.turn.reasoning_effort');
    const cwd = targetCwd ?? normalizePath(extractLogField(body, 'cwd')) ?? '';
    const sessionPath = `${LOG_SESSION_PATH_PREFIX}${threadId}`;

    return {
      path: sessionPath,
      sessionId: threadId,
      timestamp: startTime,
      size: 0,
      modifiedAt,
      metadata: {
        id: threadId,
        rolloutPath: sessionPath,
        startTime,
        cwd,
        cliVersion: '',
        model,
        reasoningEffort,
      },
    };
  }

  return null;
}

interface ThreadCandidate {
  threadId: string;
  lastTs: number;
}

/**
 * Threads recently logged by the given processes, newest first.
 * Returns null when every logs database query failed (transient error),
 * as opposed to [] which means the query ran and found nothing.
 */
async function findThreadCandidatesForProcesses(
  processIds: string[],
  sinceMs: number
): Promise<ThreadCandidate[] | null> {
  const validProcessIds = processIds.filter((processId) => /^\d+$/.test(processId)).slice(0, 32);
  if (validProcessIds.length === 0) {
    return [];
  }

  const processFilter = validProcessIds
    .map((processId) => `process_uuid LIKE '${escapeSqlString(`pid:${processId}:%`)}'`)
    .join(' OR ');
  const sinceSeconds = Math.max(0, Math.floor(sinceMs / 1000));
  // Materializing the ts window first pins the plan to the ts index. On the
  // flat query SQLite instead scans the whole thread_id index to avoid the
  // GROUP BY sort, which walks every logged row ever written (measured
  // ~40-140ms per probe on a 273MB logs db vs ~14ms materialized). This
  // probe runs continuously, so the difference is real CPU.
  const sql = `
WITH recent_logs AS MATERIALIZED (
  SELECT thread_id, ts, ts_nanos
  FROM logs
  WHERE ts >= ${sinceSeconds}
    AND (${processFilter})
)
SELECT thread_id, max(ts) AS last_ts
FROM recent_logs
WHERE thread_id IS NOT NULL
  AND thread_id != ''
GROUP BY thread_id
ORDER BY max(ts) DESC, max(ts_nanos) DESC
LIMIT ${MAX_THREAD_CANDIDATES}
`.trim();
  // AS MATERIALIZED needs sqlite >= 3.35; an older sqlite3 CLI fallback
  // rejects it as a syntax error, so keep the flat query as a second try.
  const legacySql = `
SELECT thread_id, max(ts) AS last_ts
FROM logs
WHERE ts >= ${sinceSeconds}
  AND (${processFilter})
  AND thread_id IS NOT NULL
  AND thread_id != ''
GROUP BY thread_id
ORDER BY max(ts) DESC, max(ts_nanos) DESC
LIMIT ${MAX_THREAD_CANDIDATES}
`.trim();

  let sawSuccessfulQuery = false;
  for (const dbPath of getLogDatabaseCandidates()) {
    const output =
      (await querySqlite(dbPath, [sql])) ??
      (await querySqlite(dbPath, [legacySql]));
    if (output === null) {
      continue;
    }

    sawSuccessfulQuery = true;
    const candidates: ThreadCandidate[] = [];
    for (const line of output.split('\n')) {
      if (!line) {
        continue;
      }
      const [threadId, lastTsRaw] = line.split('\x1f');
      const lastTs = Number(lastTsRaw) * 1000;
      if (threadId && isThreadId(threadId) && Number.isFinite(lastTs)) {
        candidates.push({ threadId, lastTs });
      }
    }

    if (candidates.length > 0) {
      return candidates;
    }
  }

  return sawSuccessfulQuery ? [] : null;
}

/**
 * findRolloutBySessionId throws when the sessions directory does not exist
 * yet (rollout files are created lazily); binding must tolerate that.
 */
function findRecentRolloutBySessionId(
  threadId: string,
  maxDaysBack: number
): SessionFile | null {
  try {
    return findRolloutBySessionId(threadId, maxDaysBack);
  } catch {
    return null;
  }
}

// How established a candidate thread is. Internal Codex threads (memories,
// compaction, ...) never get a rollout file or a `threads` row, so they can
// never out-rank a real user session.
const THREAD_RANK_LOG_ONLY = 0;
const THREAD_RANK_ROLLOUT = 1;
const THREAD_RANK_CONFIRMED = 2;

interface ThreadFacts {
  rank: number;
  isSubagent: boolean;
  rolloutPath: string | null;
  fetchedAt: number;
}

async function queryThreadFactsFromState(
  threadIds: string[]
): Promise<Map<string, ThreadFacts> | null> {
  const facts = new Map<string, ThreadFacts>();
  if (threadIds.length === 0) {
    return facts;
  }

  const stateDbs = getStateDatabaseCandidates();
  if (stateDbs.length === 0) {
    // No state database on this install: nothing is known, but that is not a
    // transient failure — callers fall back to rollout-file ranking.
    return facts;
  }

  const idList = threadIds.map((id) => `'${escapeSqlString(id)}'`).join(', ');
  const statements = [
    `SELECT 'thread' AS kind, id, rollout_path, thread_source, archived FROM threads WHERE id IN (${idList})`,
    `SELECT 'edge' AS kind, child_thread_id AS id, '' AS rollout_path, '' AS thread_source, 0 AS archived
     FROM thread_spawn_edges WHERE child_thread_id IN (${idList})`,
  ];

  for (const dbPath of stateDbs) {
    const output = await querySqlite(dbPath, statements);
    if (output === null) {
      continue;
    }

    const now = Date.now();
    for (const line of output.split('\n')) {
      if (!line) {
        continue;
      }
      const [kind, threadId, rolloutPath] = line.split('\x1f');
      if (!threadId) {
        continue;
      }
      const existing = facts.get(threadId) ?? {
        rank: THREAD_RANK_CONFIRMED,
        isSubagent: false,
        rolloutPath: null,
        fetchedAt: now,
      };
      if (kind === 'edge') {
        existing.isSubagent = true;
      } else if (kind === 'thread') {
        // Normalize so the same file never appears under two path forms
        // (/var vs /private/var on macOS) and triggers a spurious rebind.
        existing.rolloutPath = normalizePath(rolloutPath) ?? null;
      }
      facts.set(threadId, existing);
    }

    return facts;
  }

  return null;
}

function isLogBackedSession(session: SessionFile | null): boolean {
  return Boolean(session?.metadata && session.path.startsWith(LOG_SESSION_PATH_PREFIX));
}

/**
 * Watch for the most recently modified rollout file
 * Returns the path to the file that should be monitored
 */
interface AnnotatedThread {
  threadId: string;
  lastTs: number;
  rank: number;
  isSubagent: boolean;
}

interface PaneThreadBinding {
  threadId: string | null;
  keepCurrent: boolean;
}

export class SessionFinder {
  private currentSession: SessionFile | null = null;
  private checkInterval: NodeJS.Timeout | null = null;
  private checkInFlight: Promise<SessionFile | null> | null = null;
  private checkQueuedForce = false;
  private targetCwd: string | null = null;
  private currentThreadId: string | null = null;
  private targetStartTime: Date | null = null;
  private lastFullResolveAt = 0;
  private fullResolveIntervalMs = FULL_RESOLVE_INTERVAL_MS;
  private boundViaProcess = false;
  private cachedPanePid: string | null = null;
  private runtimeHookOverrides: string[] = [];
  private runtimeHooksEnabled: boolean | null = null;
  private threadFactsCache = new Map<string, ThreadFacts>();

  constructor(
    targetCwd?: string,
    private onSessionChange?: (session: SessionFile | null) => void,
    targetStartTime?: Date | null
  ) {
    this.targetCwd = normalizePath(targetCwd) ?? null;
    this.targetStartTime = targetStartTime ?? null;
  }

  /**
   * Start watching for session changes
   */
  start(checkIntervalMs: number = 5000): void {
    void this.check();
    this.checkInterval = setInterval(() => void this.check(), checkIntervalMs);
  }

  /**
   * Stop watching
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Check for active or recent sessions.
   *
   * Probes spawn subprocesses, so concurrent calls (poll timer + watcher
   * bursts) coalesce onto one in-flight run; a `force` arriving mid-run is
   * replayed once afterwards so its cache-busting intent is not lost.
   */
  check(force: boolean = false): Promise<SessionFile | null> {
    if (this.checkInFlight) {
      this.checkQueuedForce ||= force;
      return this.checkInFlight;
    }

    this.checkInFlight = this.runCheck(force)
      .catch(() => this.currentSession)
      .finally(() => {
        this.checkInFlight = null;
        if (this.checkQueuedForce) {
          this.checkQueuedForce = false;
          void this.check(true);
        }
      });
    return this.checkInFlight;
  }

  private async runCheck(force: boolean): Promise<SessionFile | null> {
    const now = Date.now();
    const current = this.currentSession;
    const currentExists = current ? fs.existsSync(current.path) || isLogBackedSession(current) : false;

    if (current && currentExists) {
      try {
        const stats = fs.statSync(current.path);
        current.modifiedAt = stats.mtime;
        current.size = stats.size;
      } catch {
        // ignore stat errors
      }
    }

    // Full resolution spawns subprocesses (tmux/ps/sqlite3); between resolves
    // just refresh the cached binding.
    if (!force && now - this.lastFullResolveAt < this.fullResolveIntervalMs) {
      return this.currentSession;
    }
    this.lastFullResolveAt = now;

    const previousPath = current && currentExists ? current.path : null;

    const mainPaneId = process.env.CODEX_HUD_MAIN_PANE;
    if (!mainPaneId) {
      this.currentThreadId = null;
      this.runtimeHookOverrides = [];
      this.runtimeHooksEnabled = null;
      return this.applyResolveBackoff(
        this.resolveNextSession(this.findFallbackSession(), currentExists),
        previousPath
      );
    }

    const binding = await this.resolvePaneThreadBinding(mainPaneId, now);
    if (binding.threadId) {
      this.boundViaProcess = true;
      return this.applyResolveBackoff(
        await this.bindThread(binding.threadId, currentExists),
        previousPath
      );
    }

    // The pane process is known to be bound but this probe failed or came back
    // empty (sqlite hiccup, codex exited, idle beyond the log window): keep the
    // current binding instead of guessing by file mtime, and retry at the base
    // cadence so recovery is prompt.
    if (binding.keepCurrent) {
      this.fullResolveIntervalMs = FULL_RESOLVE_INTERVAL_MS;
      if (current && currentExists) {
        return current;
      }
    }

    const paneSnapshot = findSnapshotForPane(mainPaneId);
    if (!paneSnapshot || !this.isFreshPaneSnapshot(paneSnapshot)) {
      this.currentThreadId = null;
      return this.applyResolveBackoff(
        this.resolveNextSession(this.findPaneLaunchSession(), currentExists),
        previousPath
      );
    }

    const threadId = paneSnapshot.threadId;
    if (
      this.currentSession &&
      this.currentSession.sessionId === threadId &&
      (fs.existsSync(this.currentSession.path) || isLogBackedSession(this.currentSession))
    ) {
      this.currentThreadId = threadId;
      return this.applyResolveBackoff(this.currentSession, previousPath);
    }

    const previousThreadId = this.currentThreadId;
    this.currentThreadId = threadId;
    const next = await findSessionByThreadId(threadId, this.targetCwd);

    if (!next) {
      return this.applyResolveBackoff(
        this.resolveNextSession(null, previousThreadId === threadId && currentExists),
        previousPath
      );
    }

    return this.applyResolveBackoff(
      this.resolveNextSession(next, currentExists),
      previousPath
    );
  }

  /**
   * Back the full-resolve cadence off while consecutive resolves keep
   * returning the same session; a change or an unbound result restores the
   * base cadence.
   */
  private applyResolveBackoff(
    result: SessionFile | null,
    previousPath: string | null
  ): SessionFile | null {
    if (result !== null && previousPath !== null && result.path === previousPath) {
      this.fullResolveIntervalMs = Math.min(
        FULL_RESOLVE_INTERVAL_MAX_MS,
        Math.round(this.fullResolveIntervalMs * FULL_RESOLVE_BACKOFF_FACTOR)
      );
    } else {
      this.fullResolveIntervalMs = FULL_RESOLVE_INTERVAL_MS;
    }
    return result;
  }

  /**
   * Fast path for a rollout file appearing on disk (file-watcher event).
   * A thread we currently rank as log-only just became an established
   * session (typically the first user message of a /new session); re-rank
   * it immediately instead of waiting out the facts TTL and poll interval.
   */
  async noteRolloutAppeared(rolloutPath: string): Promise<void> {
    const parsed = parseRolloutFilename(path.basename(rolloutPath));
    if (!parsed) {
      return;
    }

    const facts = this.threadFactsCache.get(parsed.sessionId);
    if (!facts || facts.rank >= THREAD_RANK_ROLLOUT || facts.isSubagent) {
      // Unknown threads (other panes/instances) stay on the throttled path;
      // established or excluded threads have nothing to upgrade.
      return;
    }

    this.threadFactsCache.delete(parsed.sessionId);
    await this.check(true);
  }

  /**
   * Runtime hook overrides observed in the current Codex pane process tree.
   * Values are consumed only for in-memory counting and are never rendered.
   */
  getRuntimeHookOverrides(): string[] {
    return [...this.runtimeHookOverrides];
  }

  getRuntimeHooksEnabled(): boolean | null {
    return this.runtimeHooksEnabled;
  }

  /**
   * Bind to a thread chosen by the pane-process resolution.
   */
  private async bindThread(
    threadId: string,
    currentExists: boolean
  ): Promise<SessionFile | null> {
    const current = this.currentSession;

    // Already bound to a real rollout file for this thread: nothing to re-resolve.
    if (
      current &&
      currentExists &&
      current.sessionId === threadId &&
      !isLogBackedSession(current)
    ) {
      this.currentThreadId = threadId;
      return current;
    }

    const facts = this.threadFactsCache.get(threadId);
    const previousThreadId = this.currentThreadId;
    this.currentThreadId = threadId;

    let next: SessionFile | null = null;
    if (current && isLogBackedSession(current) && current.sessionId === threadId) {
      // Log-backed session: probe for the rollout file appearing (created on
      // the first user message) without rescanning the whole sessions tree.
      const rollout =
        (facts?.rolloutPath && fs.existsSync(facts.rolloutPath)
          ? buildSessionFile(facts.rolloutPath)
          : null) ?? findRecentRolloutBySessionId(threadId, 2);
      next = rollout ?? (await buildLogBackedSession(threadId, this.targetCwd)) ?? current;
    } else {
      next = await findSessionByThreadId(threadId, this.targetCwd, facts?.rolloutPath ?? null);
    }

    if (!next) {
      return this.resolveNextSession(null, previousThreadId === threadId && currentExists);
    }

    return this.resolveNextSession(next, currentExists);
  }

  /**
   * Resolve which thread of the pane's process tree the HUD should follow.
   */
  private async resolvePaneThreadBinding(
    mainPaneId: string,
    now: number
  ): Promise<PaneThreadBinding> {
    const panePid = await this.getPanePid(mainPaneId);
    if (!panePid) {
      this.runtimeHookOverrides = [];
      this.runtimeHooksEnabled = null;
      return { threadId: null, keepCurrent: this.boundViaProcess };
    }

    const processTree = await getProcessTreeSnapshot(panePid);
    if (processTree) {
      const hookState = extractCodexRuntimeHookState(processTree.commands);
      this.runtimeHookOverrides = hookState.overrides;
      this.runtimeHooksEnabled = hookState.enabled;
    }

    if (getLogDatabaseCandidates().length === 0) {
      // This Codex install has no logs database; use the legacy paths.
      return { threadId: null, keepCurrent: false };
    }

    const sinceMs = Math.max(
      now - THREAD_CANDIDATE_WINDOW_MS,
      (this.targetStartTime?.getTime() ?? 0) - 60_000
    );
    const candidates = await findThreadCandidatesForProcesses(
      processTree?.processIds ?? [panePid],
      sinceMs
    );

    if (candidates === null || candidates.length === 0) {
      return { threadId: null, keepCurrent: this.boundViaProcess };
    }

    const annotated = await this.annotateCandidates(candidates);
    const chosen = this.chooseThread(annotated);
    return { threadId: chosen, keepCurrent: this.boundViaProcess };
  }

  /**
   * Pane pid is stable for the lifetime of the pane; avoid re-spawning tmux.
   */
  private async getPanePid(mainPaneId: string): Promise<string | null> {
    if (this.cachedPanePid) {
      try {
        process.kill(Number(this.cachedPanePid), 0);
        return this.cachedPanePid;
      } catch {
        this.cachedPanePid = null;
      }
    }

    const panePid = await getPaneProcessId(mainPaneId);
    if (panePid) {
      this.cachedPanePid = panePid;
    }
    return panePid;
  }

  /**
   * Attach rank/subagent facts to candidates, refreshing the cache as needed.
   */
  private async annotateCandidates(
    candidates: ThreadCandidate[]
  ): Promise<AnnotatedThread[]> {
    const now = Date.now();
    const needsFetch: string[] = [];

    for (const candidate of candidates) {
      const cached = this.threadFactsCache.get(candidate.threadId);
      if (!cached) {
        needsFetch.push(candidate.threadId);
        continue;
      }
      const isFinal = cached.rank >= THREAD_RANK_ROLLOUT || cached.isSubagent;
      if (!isFinal && now - cached.fetchedAt > THREAD_FACTS_NEGATIVE_TTL_MS) {
        needsFetch.push(candidate.threadId);
      }
    }

    if (needsFetch.length > 0) {
      const fetched = await queryThreadFactsFromState(needsFetch);
      if (fetched !== null) {
        for (const threadId of needsFetch) {
          const stateFacts = fetched.get(threadId);
          if (stateFacts) {
            this.threadFactsCache.set(threadId, stateFacts);
            continue;
          }

          // Not in the state DB (yet): an existing rollout file still marks a
          // real session on installs without a state DB or before its row lands.
          const rollout = findRecentRolloutBySessionId(threadId, 2);
          this.threadFactsCache.set(threadId, {
            rank: rollout ? THREAD_RANK_ROLLOUT : THREAD_RANK_LOG_ONLY,
            isSubagent: false,
            rolloutPath: rollout?.path ?? null,
            fetchedAt: now,
          });
        }
      }
      // On transient state-DB failure keep whatever facts we had.
    }

    return candidates.map((candidate) => {
      const facts = this.threadFactsCache.get(candidate.threadId);
      return {
        threadId: candidate.threadId,
        lastTs: candidate.lastTs,
        rank: facts?.rank ?? THREAD_RANK_LOG_ONLY,
        isSubagent: facts?.isSubagent ?? false,
      };
    });
  }

  /**
   * Sticky thread selection: prefer established sessions, never let internal
   * helper threads steal the binding, and only switch on a sustained lead
   * (a real /new or /resume, not interleaved concurrent logging).
   */
  private chooseThread(threads: AnnotatedThread[]): string | null {
    const usable = threads.filter((thread) => !thread.isSubagent);
    if (usable.length === 0) {
      return null;
    }

    const newestTs = Math.max(...usable.map((thread) => thread.lastTs));
    const active = usable.filter(
      (thread) => newestTs - thread.lastTs <= THREAD_ACTIVE_WINDOW_MS
    );
    // Established sessions (rollout file or state row) by recent activity.
    // Activity decides between established sessions — a /new session holds
    // only a rollout file at first and must still be able to take over.
    const establishedByActivity = active
      .filter((thread) => thread.rank >= THREAD_RANK_ROLLOUT)
      .sort((left, right) => right.lastTs - left.lastTs || right.rank - left.rank);
    const newestActive = [...active].sort(
      (left, right) => right.lastTs - left.lastTs
    )[0];

    const boundId = this.boundViaProcess ? this.currentThreadId : null;
    if (!boundId) {
      // Initial binding: prefer an established session over log-only noise.
      return (establishedByActivity[0] ?? newestActive)?.threadId ?? null;
    }

    const bound = usable.find((thread) => thread.threadId === boundId);
    const challenger = establishedByActivity.find(
      (thread) => thread.threadId !== boundId
    );

    if (!bound) {
      // Bound thread went quiet beyond the window; only follow real sessions.
      return challenger?.threadId ?? null;
    }

    if (bound.rank === THREAD_RANK_LOG_ONLY) {
      // Tentative binding: upgrade to any established session, otherwise
      // follow the newest log-only thread.
      return (challenger ?? newestActive)?.threadId ?? bound.threadId;
    }

    if (challenger && challenger.lastTs - bound.lastTs >= THREAD_SWITCH_MARGIN_MS) {
      return challenger.threadId;
    }

    return bound.threadId;
  }

  /**
   * Get the current session
   */
  getCurrentSession(): SessionFile | null {
    return this.currentSession;
  }

  private resolveNextSession(
    next: SessionFile | null,
    currentExists: boolean
  ): SessionFile | null {
    if (next) {
      if (!this.currentSession || this.currentSession.path !== next.path) {
        this.currentSession = next;
        this.onSessionChange?.(next);
        return next;
      }

      this.currentSession = next;
      return this.currentSession;
    }

    if (this.currentSession && currentExists) {
      return this.currentSession;
    }

    if (this.currentSession || this.currentThreadId) {
      this.currentSession = null;
      this.onSessionChange?.(null);
    }

    return null;
  }

  private findFallbackSession(): SessionFile | null {
    const active = findActiveRollouts(60, this.targetCwd || undefined, DEFAULT_LOOKBACK_DAYS);
    if (active.length > 0) {
      return active[0] ?? null;
    }

    if (this.targetStartTime) {
      const recent = this.findBestRecentSession();
      if (recent) {
        return recent;
      }
    }

    return this.findBestRecentSession();
  }

  private findPaneLaunchSession(): SessionFile | null {
    if (!this.targetStartTime) {
      return this.findFallbackSession();
    }

    let rollouts = findRolloutsInDays(DEFAULT_LOOKBACK_DAYS);
    if (this.targetCwd) {
      rollouts = rollouts.filter((rollout) => peekRolloutCwd(rollout.path) === this.targetCwd);
    }

    const targetMs = this.targetStartTime.getTime();
    const candidates = rollouts.filter(
      (session) =>
        session.timestamp.getTime() >= targetMs - LAUNCH_ROLLOUT_BACKDATE_TOLERANCE_MS
    );

    return this.selectUniqueClosestSession(candidates);
  }

  private findBestRecentSession(): SessionFile | null {
    if (!this.targetStartTime) {
      return findMostRecentRollout(DEFAULT_LOOKBACK_DAYS, this.targetCwd || undefined);
    }

    let rollouts = findRolloutsInDays(DEFAULT_LOOKBACK_DAYS);
    if (this.targetCwd) {
      rollouts = rollouts.filter((rollout) => peekRolloutCwd(rollout.path) === this.targetCwd);
    }

    return this.selectBestSession(rollouts);
  }

  private isFreshPaneSnapshot(snapshot: PaneSnapshot): boolean {
    if (!this.targetStartTime || !snapshot.timestamp) {
      return true;
    }

    const targetMs = this.targetStartTime.getTime();
    return snapshot.timestamp.getTime() >= targetMs - PANE_SNAPSHOT_STALE_TOLERANCE_MS;
  }

  private selectBestSession(sessions: SessionFile[]): SessionFile | null {
    if (sessions.length === 0) {
      return null;
    }

    if (!this.targetStartTime) {
      const sorted = sessions.sort((left, right) => right.modifiedAt.getTime() - left.modifiedAt.getTime());
      return sorted[0] ?? null;
    }

    const targetMs = this.targetStartTime.getTime();

    let candidates = sessions.filter(
      (session) => Math.abs(session.timestamp.getTime() - targetMs) <= TARGET_START_TOLERANCE_MS
    );

    if (candidates.length === 0) {
      candidates = sessions;
    }

    candidates.sort((left, right) => {
      const leftDelta = Math.abs(left.timestamp.getTime() - targetMs);
      const rightDelta = Math.abs(right.timestamp.getTime() - targetMs);
      if (leftDelta !== rightDelta) {
        return leftDelta - rightDelta;
      }
      return right.modifiedAt.getTime() - left.modifiedAt.getTime();
    });

    return candidates[0] ?? null;
  }

  private selectUniqueClosestSession(sessions: SessionFile[]): SessionFile | null {
    if (sessions.length === 0) {
      return null;
    }

    if (!this.targetStartTime) {
      return this.selectBestSession(sessions);
    }

    const targetMs = this.targetStartTime.getTime();
    const sorted = [...sessions].sort((left, right) => {
      const leftDelta = Math.abs(left.timestamp.getTime() - targetMs);
      const rightDelta = Math.abs(right.timestamp.getTime() - targetMs);
      if (leftDelta !== rightDelta) {
        return leftDelta - rightDelta;
      }
      return right.modifiedAt.getTime() - left.modifiedAt.getTime();
    });

    const best = sorted[0];
    const second = sorted[1];
    if (!best) {
      return null;
    }

    if (
      second &&
      Math.abs(second.timestamp.getTime() - targetMs) ===
        Math.abs(best.timestamp.getTime() - targetMs)
    ) {
      return null;
    }

    return best;
  }
}
