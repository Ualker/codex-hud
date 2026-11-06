/** Filesystem discovery and canonical rollout identity, independent of pane binding. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getSessionsDir } from '../utils/codex-path.js';
import { fileWasReplaced, sameFileVersion, readFileVersion, type FileVersion } from '../utils/file-version.js';
import type { SessionInfo } from '../types.js';
const DEFAULT_LOOKBACK_DAYS = 30;

export interface SessionFile {
  path: string;
  sessionId: string;
  timestamp: Date;
  size: number;
  modifiedAt: Date;
  metadata?: SessionInfo;
}

export function normalizePath(input?: string | null): string | null {
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
  sessionId: string | null;
  source?: SessionInfo['source'];
  version: FileVersion;
}

// Appends cannot change session_meta, but rotation/replacement can. Keep the
// cheap stat check so a same-path replacement cannot inherit another identity.
const rolloutCwdCache = new Map<string, RolloutCwdCacheEntry>();
const ROLLOUT_CWD_CACHE_LIMIT = 8192;

export function peekRolloutMetadata(filePath: string): RolloutCwdCacheEntry | null {
  const cached = rolloutCwdCache.get(filePath);
  let version: FileVersion;
  try {
    version = readFileVersion(filePath, cached?.version);
  } catch {
    rolloutCwdCache.delete(filePath);
    return null;
  }
  if (cached && !fileWasReplaced(cached.version, version) &&
    ((cached.cwd !== null && cached.sessionId !== null) || sameFileVersion(cached.version, version))) {
    cached.version = version;
    return cached;
  }

  let cwd: string | null = null;
  let sessionId: string | null = null;
  let source: SessionInfo['source'];
  try {
    const firstLine = readFirstLine(filePath);
    if (firstLine) {
      const entry = JSON.parse(firstLine.trim());
      if (entry.type === 'session_meta' && entry.payload) {
        cwd = normalizePath(entry.payload.cwd);
        source = entry.payload.source;
        if (typeof entry.payload.id === 'string' && entry.payload.id.length > 0 && entry.payload.id.length <= 512) {
          sessionId = entry.payload.id;
        }
      }
    }
  } catch {
    // Ignore errors or malformed files
  }

  if (rolloutCwdCache.size >= ROLLOUT_CWD_CACHE_LIMIT) {
    rolloutCwdCache.clear();
  }
  const metadata = { cwd, sessionId, source, version };
  rolloutCwdCache.set(filePath, metadata);
  return metadata;
}

export function peekRolloutCwd(filePath: string): string | null {
  return peekRolloutMetadata(filePath)?.cwd ?? null;
}

/**
 * Parse a rollout filename to extract timestamp and session ID
 * Format: rollout-YYYY-MM-DDTHH-MM-SS-<session-id>.jsonl
 */
export function parseRolloutFilename(filename: string): { timestamp: Date; sessionId: string } | null {
  // Match pattern: rollout-2026-01-15T17-47-44-019bc10d-c89d-7352-935c-76b351384357.jsonl
  const match = filename.match(
    /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([a-f0-9-]+)(?:_[a-f0-9-]+)?\.jsonl$/
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
function findRolloutsInDir(dirPath: string, strict: boolean = false): SessionFile[] {
  const results: SessionFile[] = [];

  if (!strict && !fs.existsSync(dirPath)) {
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
        if (!stats.isFile()) continue;
        if (peekRolloutMetadata(fullPath)?.sessionId !== parsed.sessionId) continue;
        results.push({
          path: fullPath,
          sessionId: parsed.sessionId,
          timestamp: parsed.timestamp,
          size: stats.size,
          modifiedAt: stats.mtime,
        });
      } catch (error) {
        if (strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // Skip files we cannot stat
      }
    }
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Directory read error
  }

  return results;
}

/**
 * Find all rollout files within the last N days
 */
export function findRolloutsInDays(maxDaysBack: number = DEFAULT_LOOKBACK_DAYS): SessionFile[] {
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
  maxDaysBack: number = DEFAULT_LOOKBACK_DAYS,
  options: { strict?: boolean } = {}
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
    rollouts = rollouts.concat(findRolloutsInDir(dayDir, options.strict));
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

    const match = rolloutsInDay.filter((r) => r.sessionId === sessionId)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime() ||
        b.modifiedAt.getTime() - a.modifiedAt.getTime())[0];
    if (match) {
      return match;
    }
  }

  return null;
}
