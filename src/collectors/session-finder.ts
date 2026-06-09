/**
 * Session finder for locating active/recent Codex session rollout files
 * Searches ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 */

import * as fs from 'fs';
import * as path from 'path';
import { getCodexHome, getSessionsDir } from '../utils/codex-path.js';

const DEFAULT_LOOKBACK_DAYS = 30;
const TARGET_START_TOLERANCE_MS = 10 * 60 * 1000;
const PANE_SNAPSHOT_STALE_TOLERANCE_MS = 30 * 1000;
const LAUNCH_ROLLOUT_BACKDATE_TOLERANCE_MS = 30 * 1000;

export interface SessionFile {
  path: string;
  sessionId: string;
  timestamp: Date;
  size: number;
  modifiedAt: Date;
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

function findSessionByThreadId(sessionId: string): SessionFile | null {
  const codexHome = getCodexHome();
  const activePath = findRolloutPathBySessionIdInRoot(path.join(codexHome, 'sessions'), sessionId);
  const archivedPath = findRolloutPathBySessionIdInRoot(
    path.join(codexHome, ARCHIVED_SESSIONS_SUBDIR),
    sessionId
  );

  return buildSessionFile(activePath ?? archivedPath ?? '');
}

/**
 * Watch for the most recently modified rollout file
 * Returns the path to the file that should be monitored
 */
export class SessionFinder {
  private currentSession: SessionFile | null = null;
  private checkInterval: NodeJS.Timeout | null = null;
  private targetCwd: string | null = null;
  private currentThreadId: string | null = null;
  private targetStartTime: Date | null = null;

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
  check(): SessionFile | null {
    const current = this.currentSession;
    const currentExists = current ? fs.existsSync(current.path) : false;

    if (current && currentExists) {
      try {
        const stats = fs.statSync(current.path);
        current.modifiedAt = stats.mtime;
        current.size = stats.size;
      } catch {
        // ignore stat errors
      }
    }

    const mainPaneId = process.env.CODEX_HUD_MAIN_PANE;
    if (!mainPaneId) {
      this.currentThreadId = null;
      return this.resolveNextSession(this.findFallbackSession(), currentExists);
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
      fs.existsSync(this.currentSession.path)
    ) {
      try {
        const stats = fs.statSync(this.currentSession.path);
        this.currentSession.modifiedAt = stats.mtime;
        this.currentSession.size = stats.size;
      } catch {
        // ignore stat errors
      }
      this.currentThreadId = threadId;
      return this.currentSession;
    }

    const previousThreadId = this.currentThreadId;
    this.currentThreadId = threadId;
    const next = findSessionByThreadId(threadId);

    if (!next) {
      return this.resolveNextSession(null, previousThreadId === threadId && currentExists);
    }

    return this.resolveNextSession(next, currentExists);
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
