import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { SessionOverview, SessionOverviewItem } from '../types.js';
import { buildContextUsage } from '../context-usage.js';
import { getCodexDataNamespace } from '../utils/codex-path.js';
import { readSharedSnapshot, writeSharedSnapshot } from '../utils/shared-snapshot.js';
import { withDetectorPhases } from '../utils/detector-phases.js';
import { sessionTitle } from '../utils/privacy.js';
import { isSubagentSessionSource } from './agent-activity.js';
import { findActiveRollouts, peekRolloutMetadata, type SessionFile } from './session-finder.js';
import { listOpenHudBindings, type OpenHudBinding } from './open-huds.js';
import { compareOverviewSessions } from './overview-order.js';
import { RolloutParser } from './rollout.js';

const PARSER_LIMIT = 20;
const PARSES_PER_REFRESH = 8;
const WORK_BUDGET_MS = 100;

function statSafely(file: string): fs.Stats | null {
  try { return fs.statSync(file); } catch { return null; }
}

function reviveOverview(value: unknown): SessionOverview | null {
  if (!value || typeof value !== 'object') return null;
  const snapshot = value as SessionOverview;
  if (!Array.isArray(snapshot.sessions) || !snapshot.sessions.every(row => row && typeof row.id === 'string')) return null;
  const date = (value: unknown): Date | undefined => {
    const result = new Date(value as string);
    return Number.isFinite(result.getTime()) ? result : undefined;
  };
  const updatedAt = date(snapshot.updatedAt);
  if (!updatedAt) return null;
  return {
    ...snapshot, updatedAt,
    sessions: snapshot.sessions.map(row => ({
      ...row, lastActivityAt: date(row.lastActivityAt),
      contextUsage: row.contextUsage ? { ...row.contextUsage, lastCompactTime: date(row.contextUsage.lastCompactTime) } : undefined,
      turnActivity: row.turnActivity ? {
        ...row.turnActivity,
        since: date(row.turnActivity.since) ?? updatedAt,
        lastActivityAt: date(row.turnActivity.lastActivityAt) ?? updatedAt,
      } : undefined,
    })),
  };
}

/** Small row snapshots outlive parsers; work and memory stay bounded even with 100 open HUDs. */
export class OverviewCollector {
  private parsers = new Map<string, RolloutParser>();
  private checkedAt = new Map<string, number>();
  private previous: SessionOverview = { sessions: [], updatedAt: new Date(0) };
  private lastParseCount = 0;

  constructor(private options: { shared?: boolean; now?: () => number } = {}) {}

  getDiagnostics(): { parserCount: number; parsedLastRefresh: number; sessionCount: number } {
    return { parserCount: this.parsers.size, parsedLastRefresh: this.lastParseCount, sessionCount: this.previous.sessions.length };
  }

  async refresh(priorityIds: readonly string[] = []): Promise<SessionOverview> {
    const now = (this.options.now ?? Date.now)();
    const namespace = getCodexDataNamespace();
    // Scope snapshots to the tmux server as well: panes from a private test
    // socket or another user's server are never valid navigation targets here.
    const server = process.env.TMUX?.split(',')[0] ?? process.env.TMUX_TMPDIR ?? 'default';
    const privacy = process.env.CODEX_HUD_HIDE_TITLES === '1' ? '-private' : '';
    const cacheKey = `overview-${namespace}-${createHash('sha256').update(server).digest('hex').slice(0, 12)}${privacy}`;
    const shared = this.options.shared === false ? null : readSharedSnapshot(cacheKey, 1500, reviveOverview, now);
    if (shared?.namespace === namespace && shared.updatedAt > this.previous.updatedAt) {
      this.previous = shared;
      this.lastParseCount = 0;
      return shared;
    }
    const [scanned, bindings] = await Promise.all([
      Promise.resolve(findActiveRollouts(30 * 60, undefined, 1, { strict: true })),
      listOpenHudBindings({ strict: true, namespace }),
    ]);
    const filesById = new Map<string, SessionFile>();
    for (const file of scanned) {
      const previous = filesById.get(file.sessionId);
      if (!previous || file.timestamp > previous.timestamp ||
        (file.timestamp.getTime() === previous.timestamp.getTime() && file.modifiedAt > previous.modifiedAt)) {
        filesById.set(file.sessionId, file);
      }
    }
    const byId = new Map(bindings.map(binding => [binding.sessionId, binding]));
    const withoutRollout: OpenHudBinding[] = [];
    for (const binding of bindings) {
      // A live pane's binding wins over historical rollouts of a resumed ID.
      filesById.delete(binding.sessionId);
      const stats = binding.rolloutPath ? statSafely(binding.rolloutPath) : null;
      const metadata = binding.rolloutPath ? peekRolloutMetadata(binding.rolloutPath) : null;
      if (!binding.rolloutPath || !stats ||
        (metadata?.sessionId && metadata.sessionId !== binding.sessionId)) {
        withoutRollout.push(binding);
      } else {
        filesById.set(binding.sessionId, { path: binding.rolloutPath, sessionId: binding.sessionId, size: stats.size, timestamp: stats.mtime, modifiedAt: stats.mtime });
      }
    }
    // Identity/type metadata outlives the much smaller parser LRU. Filtering
    // before scheduling also keeps deferred subagents out of placeholder rows.
    const files = [...filesById.values()].filter(file =>
      !isSubagentSessionSource(peekRolloutMetadata(file.path)?.source));

    const previousById = new Map(this.previous.sessions.map(row => [row.id, row]));
    const priority = new Set(priorityIds);
    const interval = (id: string): number => priority.has(id) ||
      ['awaiting-approval', 'failed', 'interrupted'].includes(previousById.get(id)?.turnActivity?.phase ?? '') ? 5000 : 30_000;
    const urgency = (file: typeof files[number]): number => {
      if (this.parsers.get(file.path)?.getCached()?.hasMore) return 100;
      const checked = this.checkedAt.get(file.path);
      if (checked === undefined) return priority.has(file.sessionId) ? 1000 : 999;
      return (now - checked) / interval(file.sessionId);
    };
    files.sort((a, b) => urgency(b) - urgency(a));
    const sessions: SessionOverviewItem[] = [];
    const started = performance.now();
    this.lastParseCount = 0;
    for (const file of files) {
      let parser = this.parsers.get(file.path);
      let unavailable = false;
      let deferred = urgency(file) >= 1;
      if (deferred && this.lastParseCount < PARSES_PER_REFRESH &&
        (this.lastParseCount === 0 || performance.now() - started < WORK_BUDGET_MS)) {
        if (!parser) {
          parser = new RolloutParser(3);
          parser.setRolloutPath(file.path);
        }
        this.parsers.delete(file.path);
        this.parsers.set(file.path, parser);
        while (this.parsers.size > PARSER_LIMIT) this.parsers.delete(this.parsers.keys().next().value!);
        this.lastParseCount++;
        this.checkedAt.set(file.path, now);
        try { await parser.parse(); } catch { unavailable = true; }
        deferred = false;
      }
      const result = parser?.getCached();
      const binding = byId.get(file.sessionId);
      const previous = previousById.get(file.sessionId);
      const identityMismatch = Boolean(result?.session && result.session.id !== file.sessionId);
      if (!result?.session || identityMismatch) {
        sessions.push({
          ...previous, id: file.sessionId,
          cwd: previous?.cwd ?? binding?.cwd,
          projectName: previous?.projectName ?? (binding?.cwd ? path.basename(binding.cwd) : undefined),
          title: sessionTitle(previous?.title, binding?.label), label: binding?.label,
          tmuxSession: binding?.tmuxSession,
          unavailable: unavailable || identityMismatch || (!deferred && !previous),
          refreshing: deferred,
        });
        continue;
      }
      if (isSubagentSessionSource(result.session.source)) continue;
      const usage = result.tokenUsage;
      const context = usage ? buildContextUsage(usage, result.compactCount, result.lastCompactTime ?? undefined) : undefined;
      sessions.push({
        id: result.session.id, cwd: result.session.cwd,
        projectName: path.basename(result.session.cwd), tmuxSession: binding?.tmuxSession,
        title: sessionTitle(result.session.title, binding?.label), label: binding?.label, model: result.session.model,
        turnActivity: withDetectorPhases(result.turnActivity, binding?.approvalNeeded === true,
          binding?.likelyInterrupted === true, binding?.codexExited === true, result.lastEventTime ?? undefined),
        lastActivityAt: result.lastEventTime ?? result.turnActivity?.lastActivityAt,
        contextUsage: context ?? undefined,
        unavailable, refreshing: deferred || result.hasMore === true,
        ...(binding?.freshPrompt ? { freshPrompt: true } : {}),
      });
    }
    for (const binding of withoutRollout) {
      sessions.push({
        id: binding.sessionId, cwd: binding.cwd,
        projectName: binding.cwd ? path.basename(binding.cwd) : undefined,
        tmuxSession: binding.tmuxSession, title: binding.label, label: binding.label,
        neverStarted: !binding.rolloutPath,
        ...(binding.rolloutPath ? { unavailable: true } : {}),
      });
    }
    const activePaths = new Set(files.map(file => file.path));
    for (const file of this.checkedAt.keys()) if (!activePaths.has(file)) this.checkedAt.delete(file);
    for (const file of this.parsers.keys()) if (!activePaths.has(file)) this.parsers.delete(file);
    sessions.sort(compareOverviewSessions);
    this.previous = { sessions, updatedAt: new Date(now), namespace };
    if (this.options.shared !== false) writeSharedSnapshot(cacheKey, this.previous, now);
    return this.previous;
  }
}
