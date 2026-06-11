/**
 * Session finder for locating active/recent Codex session rollout files
 * Searches ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { getCodexHome, getSessionsDir } from '../utils/codex-path.js';
import type { SessionInfo } from '../types.js';

const DEFAULT_LOOKBACK_DAYS = 30;
const TARGET_START_TOLERANCE_MS = 10 * 60 * 1000;
const PANE_SNAPSHOT_STALE_TOLERANCE_MS = 30 * 1000;
const LAUNCH_ROLLOUT_BACKDATE_TOLERANCE_MS = 30 * 1000;

// Spawned probes (tmux/ps/sqlite3) can take multiple seconds on a loaded
// machine purely from process startup overhead; a tight timeout makes binding
// fail randomly.
const PROBE_TIMEOUT_MS = 8000;
// Full pane->thread resolution is expensive (subprocess spawns); throttle it so
// the 1s render loop reuses the cached binding.
const FULL_RESOLVE_INTERVAL_MS = 4000;
// How far back to look for log rows tying a process to a thread.
const THREAD_CANDIDATE_WINDOW_MS = 24 * 60 * 60 * 1000;
// Candidates older than this relative to the newest one are ignored (guards
// against pid reuse picking up threads of a long-dead process).
const THREAD_ACTIVE_WINDOW_MS = 60 * 1000;
// A confirmed thread must out-log the bound thread by this margin before the
// HUD rebinds (a /new or /resume switch, not interleaved concurrent logging).
const THREAD_SWITCH_MARGIN_MS = 10 * 1000;
const MAX_THREAD_CANDIDATES = 8;
const THREAD_FACTS_NEGATIVE_TTL_MS = 60 * 1000;

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

function peekRolloutCwd(filePath: string): string | null {
  try {
    const firstLine = readFirstLine(filePath);
    if (!firstLine) return null;

    const entry = JSON.parse(firstLine.trim());
    if (entry.type === 'session_meta' && entry.payload) {
      return normalizePath(entry.payload.cwd);
    }
  } catch {
    // Ignore errors or malformed files
  }
  return null;
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
    const match = content.match(
      /(?:^|\n)(?:export\s+)?TMUX_PANE=(?:'([^']*)'|"([^"]*)"|([^\n]+))/
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

function findRolloutPathBySessionIdInRoot(rootDir: string, sessionId: string): string | null {
  if (!fs.existsSync(rootDir)) {
    return null;
  }

  const expectedSuffix = `-${sessionId}.jsonl`;
  const stack = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
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

function findSessionByThreadId(
  sessionId: string,
  targetCwd: string | null,
  knownRolloutPath?: string | null
): SessionFile | null {
  if (knownRolloutPath && fs.existsSync(knownRolloutPath)) {
    const knownSession = buildSessionFile(knownRolloutPath);
    if (knownSession) {
      return knownSession;
    }
  }

  const codexHome = getCodexHome();
  const activePath = findRolloutPathBySessionIdInRoot(path.join(codexHome, 'sessions'), sessionId);
  const archivedPath = findRolloutPathBySessionIdInRoot(
    path.join(codexHome, ARCHIVED_SESSIONS_SUBDIR),
    sessionId
  );

  const rolloutSession = buildSessionFile(activePath ?? archivedPath ?? '');
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

function querySqlite(dbPath: string, sql: string): string | null {
  try {
    return execFileSync('sqlite3', ['-readonly', '-separator', '\x1f', dbPath, sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS,
    }).trimEnd();
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

function getPaneProcessId(mainPaneId: string): string | null {
  try {
    const output = execFileSync('tmux', ['display', '-p', '-t', mainPaneId, '#{pane_pid}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS,
    }).trim();
    return /^\d+$/.test(output) ? output : null;
  } catch {
    return null;
  }
}

function getDescendantProcessIds(rootPid: string): string[] {
  if (!/^\d+$/.test(rootPid)) {
    return [];
  }

  let output: string;
  try {
    output = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS,
    });
  } catch {
    return [rootPid];
  }

  const childrenByParent = new Map<string, string[]>();
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+/);
    if (!match) {
      continue;
    }

    const pid = match[1];
    const parentPid = match[2];
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

  return result;
}

function extractLogField(body: string, field: string): string | undefined {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = body.match(new RegExp(`(?:^|[\\s{])${escaped}=([^\\s}]+)`));
  return match?.[1];
}

function buildLogBackedSession(
  threadId: string,
  targetCwd: string | null
): SessionFile | null {
  if (!isThreadId(threadId)) {
    return null;
  }

  const escapedThreadId = escapeSqlString(threadId);
  const sql = `
SELECT
  COALESCE((SELECT min(ts) FROM logs WHERE thread_id = '${escapedThreadId}'), 0),
  COALESCE((SELECT max(ts) FROM logs WHERE thread_id = '${escapedThreadId}'), 0),
  COALESCE((
    SELECT replace(replace(feedback_log_body, char(10), ' '), char(13), ' ')
    FROM logs
    WHERE thread_id = '${escapedThreadId}' AND feedback_log_body IS NOT NULL
    ORDER BY ts DESC, ts_nanos DESC, id DESC
    LIMIT 1
  ), '');
`.trim();

  for (const dbPath of getLogDatabaseCandidates()) {
    const output = querySqlite(dbPath, sql);
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
function findThreadCandidatesForProcesses(
  processIds: string[],
  sinceMs: number
): ThreadCandidate[] | null {
  const validProcessIds = processIds.filter((processId) => /^\d+$/.test(processId)).slice(0, 32);
  if (validProcessIds.length === 0) {
    return [];
  }

  const processFilter = validProcessIds
    .map((processId) => `process_uuid LIKE '${escapeSqlString(`pid:${processId}:%`)}'`)
    .join(' OR ');
  const sinceSeconds = Math.max(0, Math.floor(sinceMs / 1000));
  const sql = `
SELECT thread_id, max(ts)
FROM logs
WHERE ts >= ${sinceSeconds}
  AND (${processFilter})
  AND thread_id IS NOT NULL
  AND thread_id != ''
GROUP BY thread_id
ORDER BY max(ts) DESC, max(ts_nanos) DESC
LIMIT ${MAX_THREAD_CANDIDATES};
`.trim();

  let sawSuccessfulQuery = false;
  for (const dbPath of getLogDatabaseCandidates()) {
    const output = querySqlite(dbPath, sql);
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

function queryThreadFactsFromState(threadIds: string[]): Map<string, ThreadFacts> | null {
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
  const sql = `
SELECT 'thread', id, rollout_path, thread_source, archived FROM threads WHERE id IN (${idList});
SELECT 'edge', child_thread_id, '', '', 0 FROM thread_spawn_edges WHERE child_thread_id IN (${idList});
`.trim();

  for (const dbPath of stateDbs) {
    const output = querySqlite(dbPath, sql);
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
  private targetCwd: string | null = null;
  private currentThreadId: string | null = null;
  private targetStartTime: Date | null = null;
  private lastFullResolveAt = 0;
  private boundViaProcess = false;
  private cachedPanePid: string | null = null;
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
    this.check();
    this.checkInterval = setInterval(() => this.check(), checkIntervalMs);
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
   * Check for active or recent sessions
   */
  check(force: boolean = false): SessionFile | null {
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
    if (!force && now - this.lastFullResolveAt < FULL_RESOLVE_INTERVAL_MS) {
      return this.currentSession;
    }
    this.lastFullResolveAt = now;

    const mainPaneId = process.env.CODEX_HUD_MAIN_PANE;
    if (!mainPaneId) {
      this.currentThreadId = null;
      return this.resolveNextSession(this.findFallbackSession(), currentExists);
    }

    const binding = this.resolvePaneThreadBinding(mainPaneId, now);
    if (binding.threadId) {
      this.boundViaProcess = true;
      return this.bindThread(binding.threadId, currentExists);
    }

    // The pane process is known to be bound but this probe failed or came back
    // empty (sqlite hiccup, codex exited, idle beyond the log window): keep the
    // current binding instead of guessing by file mtime.
    if (binding.keepCurrent && current && currentExists) {
      return current;
    }

    const paneSnapshot = findSnapshotForPane(mainPaneId);
    if (!paneSnapshot || !this.isFreshPaneSnapshot(paneSnapshot)) {
      this.currentThreadId = null;
      return this.resolveNextSession(this.findPaneLaunchSession(), currentExists);
    }

    const threadId = paneSnapshot.threadId;
    if (
      this.currentSession &&
      this.currentSession.sessionId === threadId &&
      (fs.existsSync(this.currentSession.path) || isLogBackedSession(this.currentSession))
    ) {
      this.currentThreadId = threadId;
      return this.currentSession;
    }

    const previousThreadId = this.currentThreadId;
    this.currentThreadId = threadId;
    const next = findSessionByThreadId(threadId, this.targetCwd);

    if (!next) {
      return this.resolveNextSession(null, previousThreadId === threadId && currentExists);
    }

    return this.resolveNextSession(next, currentExists);
  }

  /**
   * Bind to a thread chosen by the pane-process resolution.
   */
  private bindThread(threadId: string, currentExists: boolean): SessionFile | null {
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
      next = rollout ?? buildLogBackedSession(threadId, this.targetCwd) ?? current;
    } else {
      next = findSessionByThreadId(threadId, this.targetCwd, facts?.rolloutPath ?? null);
    }

    if (!next) {
      return this.resolveNextSession(null, previousThreadId === threadId && currentExists);
    }

    return this.resolveNextSession(next, currentExists);
  }

  /**
   * Resolve which thread of the pane's process tree the HUD should follow.
   */
  private resolvePaneThreadBinding(mainPaneId: string, now: number): PaneThreadBinding {
    const panePid = this.getPanePid(mainPaneId);
    if (!panePid) {
      return { threadId: null, keepCurrent: this.boundViaProcess };
    }

    if (getLogDatabaseCandidates().length === 0) {
      // This Codex install has no logs database; use the legacy paths.
      return { threadId: null, keepCurrent: false };
    }

    const sinceMs = Math.max(
      now - THREAD_CANDIDATE_WINDOW_MS,
      (this.targetStartTime?.getTime() ?? 0) - 60_000
    );
    const candidates = findThreadCandidatesForProcesses(
      getDescendantProcessIds(panePid),
      sinceMs
    );

    if (candidates === null || candidates.length === 0) {
      return { threadId: null, keepCurrent: this.boundViaProcess };
    }

    const annotated = this.annotateCandidates(candidates);
    const chosen = this.chooseThread(annotated);
    return { threadId: chosen, keepCurrent: this.boundViaProcess };
  }

  /**
   * Pane pid is stable for the lifetime of the pane; avoid re-spawning tmux.
   */
  private getPanePid(mainPaneId: string): string | null {
    if (this.cachedPanePid) {
      try {
        process.kill(Number(this.cachedPanePid), 0);
        return this.cachedPanePid;
      } catch {
        this.cachedPanePid = null;
      }
    }

    const panePid = getPaneProcessId(mainPaneId);
    if (panePid) {
      this.cachedPanePid = panePid;
    }
    return panePid;
  }

  /**
   * Attach rank/subagent facts to candidates, refreshing the cache as needed.
   */
  private annotateCandidates(candidates: ThreadCandidate[]): AnnotatedThread[] {
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
      const fetched = queryThreadFactsFromState(needsFetch);
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
    const best = [...active].sort(
      (left, right) => right.rank - left.rank || right.lastTs - left.lastTs
    )[0];
    if (!best) {
      return null;
    }

    const boundId = this.boundViaProcess ? this.currentThreadId : null;
    if (!boundId) {
      return best.threadId;
    }

    const bound = usable.find((thread) => thread.threadId === boundId);
    if (!bound) {
      // Bound thread went quiet beyond the window; only follow real sessions.
      return best.rank >= THREAD_RANK_ROLLOUT ? best.threadId : null;
    }

    if (best.threadId === bound.threadId) {
      return bound.threadId;
    }
    if (bound.rank === THREAD_RANK_LOG_ONLY && best.rank > THREAD_RANK_LOG_ONLY) {
      return best.threadId;
    }
    if (
      best.rank >= THREAD_RANK_ROLLOUT &&
      best.lastTs - bound.lastTs >= THREAD_SWITCH_MARGIN_MS
    ) {
      return best.threadId;
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
