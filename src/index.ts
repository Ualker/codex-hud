/**
 * Codex HUD - Main entry point
 * Phase 3: Redesigned with claude-hud style rendering
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  collectGitStatusAsync,
  emptyGitStatus,
} from './collectors/git.js';
import { SessionFinder, findActiveRollouts } from './collectors/session-finder.js';
import {
  AgentActivityCollector,
  AGENT_INACTIVITY_TIMEOUT_ENV,
  isSubagentSessionSource,
  parseAgentInactivityTimeoutMs,
} from './collectors/agent-activity.js';
import { RolloutParser } from './collectors/rollout.js';
import {
  SlowProjectWorkerClient,
  type SlowProjectSnapshot,
} from './collectors/slow-project-client.js';
import {
  listOpenHudBindings,
  publishHudBinding,
  type OpenHudBinding,
} from './collectors/open-huds.js';
import { createParseQueue } from './utils/parse-queue.js';
import { AsyncSnapshotCache } from './utils/async-snapshot-cache.js';
import {
  GIT_SLOW_MS,
  planCadence,
  type CadencePlan,
} from './utils/idle-policy.js';
import { HudFileWatcher } from './collectors/file-watcher.js';
import {
  renderToStdout,
  cleanupRenderer,
  invalidateRenderedFrame,
  revealStatusHint,
} from './render/index.js';
import { cycleToolDetailsMode } from './render/lines/activity-line.js';
import { logHudError } from './utils/hud-log.js';
import { calculateContextUsage } from './context-usage.js';
import type {
  HudData,
  TokenUsage,
  ContextUsage,
  HudDisplayMode,
  SessionOverview,
  SessionOverviewItem,
  TokenUsageInfo,
  CollectorHealth,
  CollectorHealthMap,
  ProjectInfo,
} from './types.js';

// Session start time
const SESSION_START = new Date();

// Refresh intervals come from the cadence policy (utils/idle-policy.ts);
// this is only the fallback used when a render tick itself throws.
const RENDER_ERROR_RETRY_INTERVAL = 1500;
const GIT_CACHE_TTL_MS = 5000;
const PROJECT_CACHE_TTL_MS = 60_000;
const OVERVIEW_CACHE_TTL_MS = 5000;
const OVERVIEW_ACTIVE_WINDOW_SECONDS = 30 * 60;

// Current working directory for the HUD
const HUD_CWD = process.env.CODEX_HUD_CWD || process.cwd();
const HUD_CWD_REAL = (() => {
  try {
    return fs.realpathSync(HUD_CWD);
  } catch {
    return HUD_CWD;
  }
})();

// Optional HUD session start time (for session isolation)
const HUD_SESSION_START = (() => {
  const raw = process.env.CODEX_HUD_SESSION_START;
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return parsed > 1_000_000_000_000 ? new Date(parsed) : new Date(parsed * 1000);
})();

// Track if we're running
let isRunning = true;
let isShuttingDown = false;
let gitRefreshTimer: NodeJS.Timeout | null = null;
let projectRefreshTimer: NodeJS.Timeout | null = null;
let overviewRefreshTimer: NodeJS.Timeout | null = null;
let agentRefreshTimer: NodeJS.Timeout | null = null;
let rolloutFallbackTimer: NodeJS.Timeout | null = null;

// Display mode (single vs overview)
let displayMode: HudDisplayMode =
  process.env.CODEX_HUD_MODE === 'overview' ? 'overview' : 'single';

const TOGGLE_KEYS = ['\u0014']; // Ctrl+T

// Local wake signals (keypresses, toggles, resizes, watcher events) count as
// activity for the cadence policy, so an idle HUD being interacted with — or
// a fresh rollout appearing anywhere — snaps back to the base cadence.
let lastWakeSignalMs = Date.now();

function noteWakeSignal(): void {
  lastWakeSignalMs = Date.now();
}

function toggleDisplayMode(): void {
  noteWakeSignal();
  displayMode = displayMode === 'single' ? 'overview' : 'single';
  if (displayMode === 'overview') {
    void overviewCache.refresh(true).catch(() => {
      // Keep the previous overview snapshot.
    });
  }
}

function getNonCachedInputTokens(usage: TokenUsage | undefined): number {
  if (!usage) {
    return 0;
  }

  const input = usage.input_tokens ?? 0;
  const cached = usage.cached_input_tokens ?? 0;
  return Math.max(0, input - cached);
}

function buildContextUsage(
  tokenUsage: TokenUsageInfo | undefined,
  compactCount: number | undefined,
  lastCompactTime: Date | null | undefined
): ContextUsage | undefined {
  if (!tokenUsage) {
    return undefined;
  }

  const contextWindow = tokenUsage.model_context_window ?? 0;
  const lastUsage = tokenUsage.last_token_usage;

  if (contextWindow > 0 && lastUsage) {
    const tokensInContext = lastUsage.total_tokens ?? 0;
    const { used, total, percent } = calculateContextUsage(tokensInContext, contextWindow);

    return {
      used,
      total,
      percent,
      inputTokens: getNonCachedInputTokens(lastUsage),
      outputTokens: lastUsage.output_tokens ?? 0,
      cachedTokens: lastUsage.cached_input_tokens ?? 0,
      compactCount: compactCount ?? 0,
      lastCompactTime: lastCompactTime ?? undefined,
    };
  }

  return undefined;
}

// Phase 2: Session and rollout tracking
let agentActivityCollector: AgentActivityCollector;
let cachedAgentActivity: HudData['agentActivity'];
let agentRefreshInFlight: Promise<void> | null = null;
const collectorHealth: CollectorHealthMap = {};

function recordCollectorAttempt(
  name: keyof CollectorHealthMap
): CollectorHealth {
  const health: CollectorHealth = {
    ...collectorHealth[name],
    status: collectorHealth[name]?.status ?? 'stale',
    lastAttemptAt: new Date(),
  };
  collectorHealth[name] = health;
  return health;
}

function recordCollectorSuccess(name: keyof CollectorHealthMap): void {
  const now = new Date();
  collectorHealth[name] = {
    status: 'fresh',
    lastAttemptAt: collectorHealth[name]?.lastAttemptAt ?? now,
    lastSuccessAt: now,
  };
}

function recordCollectorError(
  name: keyof CollectorHealthMap,
  error: unknown
): void {
  const previous = collectorHealth[name];
  collectorHealth[name] = {
    status: 'error',
    lastAttemptAt: previous?.lastAttemptAt ?? new Date(),
    lastSuccessAt: previous?.lastSuccessAt,
    errorSummary: (error instanceof Error ? error.message : String(error))
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 180),
  };
}

const HUD_TMUX_SESSION = process.env.CODEX_HUD_TMUX_SESSION || undefined;

const sessionFinder = new SessionFinder(HUD_CWD_REAL, (session) => {
  const rolloutSession = session && fs.existsSync(session.path) ? session : null;
  // Let other HUDs' overviews see this binding. A session bound before its
  // first turn has no rollout yet, which is exactly the case file timestamps
  // cannot represent.
  void publishHudBinding(
    HUD_TMUX_SESSION,
    session?.sessionId ?? null,
    rolloutSession?.path ?? null,
    HUD_CWD
  ).catch(() => {
    // The overview degrades to the mtime scan; never fail a binding on this.
  });
  agentActivityCollector.setRootSession(rolloutSession);
  cachedAgentActivity = undefined;
  delete collectorHealth.rollout;
  delete collectorHealth.agents;
  recordCollectorAttempt('session');
  recordCollectorSuccess('session');

  // When session changes, update rollout path
  if (rolloutSession) {
    rolloutParser.setRolloutPath(rolloutSession.path);
    hudFileWatcher.setRolloutPath(rolloutSession.path);
    void refreshRolloutAndAgents();
    return;
  }

  rolloutParser.setRolloutPath(null);
  hudFileWatcher.setRolloutPath(null);
}, HUD_SESSION_START);

const rolloutParser = new RolloutParser(10);
const hudFileWatcher = new HudFileWatcher();
const parseRolloutSafely = createParseQueue(() => rolloutParser.parse());

const initialProject: ProjectInfo = {
  cwd: HUD_CWD,
  projectName: path.basename(HUD_CWD),
  agentsMdCount: 0,
  rulesCount: 0,
  mcpCount: 0,
  configsCount: 0,
  extensionsCount: 0,
  skillsCount: 0,
  otherAgentSkillsCount: 0,
  hooksCount: 0,
  globalConfigActive: false,
};
const slowProjectClient = new SlowProjectWorkerClient();
let forceNextAssetRefresh = false;
const slowProjectCache = new AsyncSnapshotCache<SlowProjectSnapshot>(
  {
    config: {},
    project: initialProject,
    collectedAt: new Date(0),
  },
  async () => {
    const forceAssetRefresh = forceNextAssetRefresh;
    forceNextAssetRefresh = false;
    try {
      return await slowProjectClient.collect(HUD_CWD, {
        runtimeHookOverrides: sessionFinder.getRuntimeHookOverrides(),
        runtimeHooksEnabled: sessionFinder.getRuntimeHooksEnabled(),
        forceAssetRefresh,
      });
    } catch (error) {
      if (forceAssetRefresh) {
        forceNextAssetRefresh = true;
      }
      throw error;
    }
  },
  {
    ttlMs: PROJECT_CACHE_TTL_MS,
    staleAfterMs: PROJECT_CACHE_TTL_MS * 2,
  }
);
const gitCache = new AsyncSnapshotCache(
  emptyGitStatus(),
  () => collectGitStatusAsync(HUD_CWD),
  {
    ttlMs: GIT_CACHE_TTL_MS,
    // The cadence policy legitimately stretches git refreshes to GIT_SLOW_MS
    // (deep idle / non-repo cwd); "stale" must mean a refresh actually missed
    // its schedule, not that the slow schedule is in effect. Real failures
    // still surface immediately through the error status.
    staleAfterMs: GIT_SLOW_MS * 1.5,
  }
);

interface OverviewParserEntry {
  size: number;
  parser: RolloutParser;
}

function statSafely(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

// Sessions drop out of the 60s active window and come back (long tool runs,
// brief idles). Parsers are kept in a bounded LRU instead of being evicted
// immediately, so re-entry resumes incrementally rather than re-reading the
// whole rollout from offset 0.
const OVERVIEW_PARSER_LIMIT = 20;
const overviewParsers = new Map<string, OverviewParserEntry>();

async function refreshOverviewData(): Promise<SessionOverview> {
  // Two sources, because neither is sufficient alone.
  //
  // The rollout scan finds sessions being worked right now, including ones
  // this machine's HUDs are not bound to. But it defines "active" as "file
  // written recently", and measured live that surfaced neither of two open
  // Codex sessions: one had not written since a resume five days earlier, the
  // other had no rollout at all because Codex creates one lazily on the first
  // turn. Every window from one minute to twelve hours returned zero rows.
  //
  // The tmux scan finds sessions that are genuinely open, which is what the
  // dashboard is for, but only those running under a codex-hud pane.
  const [scanned, openBindings] = await Promise.all([
    Promise.resolve(
      findActiveRollouts(OVERVIEW_ACTIVE_WINDOW_SECONDS, undefined, 1)
    ),
    listOpenHudBindings(),
  ]);

  const activeSessions = [...scanned];
  const scannedIds = new Set(scanned.map((session) => session.sessionId));
  const boundWithoutRollout: OpenHudBinding[] = [];
  for (const binding of openBindings) {
    if (scannedIds.has(binding.sessionId)) {
      continue;
    }
    const stats = binding.rolloutPath
      ? statSafely(binding.rolloutPath)
      : null;
    if (!binding.rolloutPath || !stats) {
      boundWithoutRollout.push(binding);
      continue;
    }
    activeSessions.push({
      path: binding.rolloutPath,
      sessionId: binding.sessionId,
      timestamp: stats.mtime,
      size: stats.size,
      modifiedAt: stats.mtime,
    });
  }

  const activePaths = new Set(activeSessions.map((session) => session.path));
  const sessions: SessionOverviewItem[] = [];

  for (const sessionFile of activeSessions) {
    let cached = overviewParsers.get(sessionFile.path);
    if (cached) {
      // Move to the tail so LRU eviction removes the least recently active.
      overviewParsers.delete(sessionFile.path);
      overviewParsers.set(sessionFile.path, cached);
    } else {
      const parser = new RolloutParser(3);
      parser.setRolloutPath(sessionFile.path);
      cached = { size: -1, parser };
      overviewParsers.set(sessionFile.path, cached);
    }

    try {
      if (cached.size !== sessionFile.size || !cached.parser.getCached()) {
        await cached.parser.parse();
        cached.size = sessionFile.size;
      }
    } catch {
      continue;
    }

    const result = cached.parser.getCached();
    if (!result || isSubagentSessionSource(result.session?.source)) {
      continue;
    }
    const contextUsage = buildContextUsage(
      result.tokenUsage ?? undefined,
      result.compactCount,
      result.lastCompactTime
    );
    const cwd = result.session?.cwd;
    sessions.push({
      id: result.session?.id ?? sessionFile.sessionId,
      cwd,
      projectName: cwd ? path.basename(cwd) : undefined,
      model: result.session?.model,
      turnActivity: result.turnActivity ?? undefined,
      lastActivityAt:
        result.lastEventTime ?? result.turnActivity?.lastActivityAt,
      contextUsage,
    });
  }

  // Sessions that are open but have never written a rollout. There is nothing
  // to parse, so the row carries identity only; the phase column renders these
  // as "Unknown" and the sort keeps them below sessions doing real work.
  for (const binding of boundWithoutRollout) {
    sessions.push({
      id: binding.sessionId,
      cwd: binding.cwd,
      projectName: binding.cwd ? path.basename(binding.cwd) : undefined,
      neverStarted: true,
    });
  }

  if (overviewParsers.size > OVERVIEW_PARSER_LIMIT) {
    for (const cachedPath of overviewParsers.keys()) {
      if (overviewParsers.size <= OVERVIEW_PARSER_LIMIT) {
        break;
      }
      if (!activePaths.has(cachedPath)) {
        overviewParsers.delete(cachedPath);
      }
    }
  }

  const phaseRank = (phase: SessionOverviewItem['turnActivity']): number => {
    switch (phase?.phase) {
      case 'running-tool':
      case 'thinking':
        return 0;
      case 'responding':
        return 1;
      case 'aborted':
        return 2;
      case 'idle':
      default:
        return 3;
    }
  };
  sessions.sort((left, right) => {
    const phaseDelta =
      phaseRank(left.turnActivity) - phaseRank(right.turnActivity);
    if (phaseDelta !== 0) {
      return phaseDelta;
    }
    const contextDelta =
      (right.contextUsage?.percent ?? 0) -
      (left.contextUsage?.percent ?? 0);
    if (contextDelta !== 0) {
      return contextDelta;
    }
    return (
      (right.lastActivityAt?.getTime() ?? 0) -
      (left.lastActivityAt?.getTime() ?? 0)
    );
  });

  return { sessions, updatedAt: new Date() };
}

const overviewCache = new AsyncSnapshotCache<SessionOverview>(
  { sessions: [], updatedAt: new Date(0) },
  refreshOverviewData,
  {
    ttlMs: OVERVIEW_CACHE_TTL_MS,
    staleAfterMs: OVERVIEW_CACHE_TTL_MS * 3,
  }
);

/**
 * Parse rollout updates outside the render clock. Returns false when there is
 * no bound rollout or the parse failed.
 */
async function refreshRolloutOnly(): Promise<boolean> {
  const session = sessionFinder.getCurrentSession();
  if (!session || !fs.existsSync(session.path)) {
    cachedAgentActivity = undefined;
    return false;
  }

  recordCollectorAttempt('rollout');
  try {
    await parseRolloutSafely();
    recordCollectorSuccess('rollout');
    return true;
  } catch (error) {
    recordCollectorError('rollout', error);
    return false;
  }
}

/**
 * Parse watcher-driven rollout and agent updates outside the render clock.
 */
async function refreshRolloutAndAgents(): Promise<void> {
  if (await refreshRolloutOnly()) {
    await refreshAgents();
  }
}

function refreshAgents(): Promise<void> {
  if (agentRefreshInFlight) {
    return agentRefreshInFlight;
  }

  const request = (async () => {
    const session = sessionFinder.getCurrentSession();
    if (!session || !fs.existsSync(session.path)) {
      cachedAgentActivity = undefined;
      return;
    }
    recordCollectorAttempt('agents');
    try {
      cachedAgentActivity = await agentActivityCollector.collect(Date.now());
      recordCollectorSuccess('agents');
    } catch (error) {
      recordCollectorError('agents', error);
    }
  })().finally(() => {
    if (agentRefreshInFlight === request) {
      agentRefreshInFlight = null;
    }
  });
  agentRefreshInFlight = request;
  return request;
}

/**
 * Assemble an in-memory snapshot. No filesystem or subprocess work belongs in
 * this function; collectors update their caches independently.
 */
function collectData(): HudData {
  const slowData = slowProjectCache.get();
  const slowHealth = slowProjectCache.getHealth();
  const slowCollectorHealth: CollectorHealthMap =
    slowHealth.status !== 'fresh'
      ? { environment: slowHealth }
      : slowData.configError
        ? {
            config: {
              status: 'error',
              lastAttemptAt: slowData.collectedAt,
            },
          }
        : {};
  const overviewHealth =
    displayMode === 'overview'
      ? { overview: overviewCache.getHealth() }
      : {};
  const baseData = {
    config: slowData.config,
    git: gitCache.get(),
    project: slowData.project,
    sessionStart: SESSION_START,
    collectorHealth: {
      ...collectorHealth,
      ...slowCollectorHealth,
      git: gitCache.getHealth(),
      ...overviewHealth,
    },
  };

  if (displayMode === 'overview') {
    return {
      ...baseData,
      displayMode,
      overview: overviewCache.get(),
      // Lets the overview mark the row this HUD is bound to.
      overviewSelfSessionId: sessionFinder.getCurrentSession()?.sessionId,
    };
  }

  const session = sessionFinder.getCurrentSession();
  const rolloutData = rolloutParser.getCached();

  // Build context usage from token usage if available
  // Matches codex "context window left" calculation based on last_token_usage.
  const contextUsage = buildContextUsage(
    rolloutData?.tokenUsage ?? undefined,
    rolloutData?.compactCount,
    rolloutData?.lastCompactTime
  );

  return {
    ...baseData,
    session: rolloutData?.session ?? session?.metadata ?? undefined,
    toolActivity: rolloutData?.toolActivity ?? undefined,
    agentActivity: cachedAgentActivity,
    planProgress: rolloutData?.planProgress ?? undefined,
    tokenUsage: rolloutData?.tokenUsage ?? undefined,
    rateLimits: rolloutData?.rateLimits ?? undefined,
    turnActivity: rolloutData?.turnActivity ?? undefined,
    protocolHealth: rolloutData?.protocolHealth,
    partialHistory: rolloutData?.partialHistory,
    contextUsage,
    displayMode,
  };
}

/**
 * Current cadence plan derived from live collector state. Cheap enough to
 * evaluate on every render tick and timer tick.
 */
function computeCadence(nowMs: number = Date.now()): CadencePlan {
  const rolloutData = rolloutParser.getCached();
  const session = sessionFinder.getCurrentSession();
  const hasRunningTool =
    rolloutData?.toolActivity?.recentCalls.some(
      (call) => call.status === 'running'
    ) ?? false;
  const phase = rolloutData?.turnActivity?.phase;
  const hasActiveTurn =
    phase !== undefined && phase !== 'idle' && phase !== 'aborted';
  const hasActiveAgent = (cachedAgentActivity?.visibleAgentCount ?? 0) > 0;
  const lastActivityMs = Math.max(
    lastWakeSignalMs,
    rolloutData?.lastEventTime?.getTime() ?? 0,
    rolloutData?.turnActivity?.lastActivityAt.getTime() ?? 0,
    session?.modifiedAt.getTime() ?? 0
  );

  return planCadence({
    nowMs,
    lastActivityMs,
    hasActiveWork: hasRunningTool || hasActiveTurn || hasActiveAgent,
    bound: session !== null,
    overviewVisible: displayMode === 'overview',
    gitIsRepo: gitCache.get().isGitRepo,
  });
}

/**
 * Main render loop
 */
async function mainLoop(): Promise<void> {
  if (!isRunning) {
    return;
  }

  try {
    renderToStdout(collectData());
    const plan = computeCadence();
    sessionFinder.setDeepIdle(plan.deepIdle);
    setTimeout(mainLoop, plan.renderMs);
  } catch (error) {
    // stderr would land inside the rendered frame; diagnostics go to the
    // optional CODEX_HUD_LOG_FILE instead.
    logHudError('render', error);
    setTimeout(mainLoop, RENDER_ERROR_RETRY_INTERVAL);
  }
}

/**
 * Handle graceful shutdown
 */
async function shutdown(): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  isRunning = false;

  if (gitRefreshTimer) {
    clearInterval(gitRefreshTimer);
  }
  if (projectRefreshTimer) {
    clearInterval(projectRefreshTimer);
  }
  if (overviewRefreshTimer) {
    clearInterval(overviewRefreshTimer);
  }
  if (agentRefreshTimer) {
    clearInterval(agentRefreshTimer);
  }
  if (rolloutFallbackTimer) {
    clearInterval(rolloutFallbackTimer);
  }
  sessionFinder.stop();
  await Promise.allSettled([
    hudFileWatcher.stop(),
    slowProjectClient.close(),
  ]);
  cleanupRenderer();
  process.exit(0);
}

async function refreshSlowProject(force: boolean = false): Promise<void> {
  if (force) {
    forceNextAssetRefresh = true;
  }
  try {
    await slowProjectCache.refresh(force);
  } catch {
    return;
  }

  // A config event can arrive while an older request is in flight. Run one
  // follow-up request so the new config/asset state is not lost to deduping.
  if (forceNextAssetRefresh && isRunning) {
    try {
      await slowProjectCache.refresh(true);
    } catch {
      // Cache health retains the failure and the previous good snapshot.
    }
  }
}

function startCollectorTimers(): void {
  // The 1s ticks below are schedulers, not workers: each one asks the
  // cadence policy how long ago its collector may have run and skips the
  // tick when the planned interval has not elapsed. This lets deep idle
  // stretch spawn-heavy probes without re-arming timers.
  let lastGitRefreshMs = 0;
  let lastAgentsRefreshMs = 0;
  let lastRolloutSweepMs = 0;

  gitRefreshTimer = setInterval(() => {
    const now = Date.now();
    if (now - lastGitRefreshMs < computeCadence(now).gitMs) {
      return;
    }
    lastGitRefreshMs = now;
    void gitCache.refresh().catch(() => {
      // Cache health is rendered from the retained last-good snapshot.
    });
  }, 1000);
  projectRefreshTimer = setInterval(() => {
    void refreshSlowProject();
  }, 5000);
  overviewRefreshTimer = setInterval(() => {
    if (displayMode === 'overview') {
      void overviewCache.refresh().catch(() => {
        // Keep the previous overview snapshot.
      });
    }
  }, 1000);
  agentRefreshTimer = setInterval(() => {
    const now = Date.now();
    if (now - lastAgentsRefreshMs < computeCadence(now).agentsMs) {
      return;
    }
    lastAgentsRefreshMs = now;
    void refreshAgents();
  }, 1000);
  // Watcher events can be lost (editor moves, network mounts, chokidar
  // hiccups); a slow stat-based sweep keeps the rollout data from freezing.
  rolloutFallbackTimer = setInterval(() => {
    const now = Date.now();
    if (now - lastRolloutSweepMs < computeCadence(now).rolloutFallbackMs) {
      return;
    }
    lastRolloutSweepMs = now;
    void refreshRolloutOnly();
  }, 1000);
}

function renderNow(): void {
  try {
    renderToStdout(collectData());
  } catch {
    // The regular render loop repaints on its next tick.
  }
}

function setupKeyListener(): void {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return;
  }

  process.stdin.setRawMode(true);
  process.stdin.on('data', (data: Buffer) => {
    noteWakeSignal();
    const input = data.toString('utf8');
    // Raw mode suppresses the terminal's SIGINT; handle Ctrl+C explicitly so
    // the pane stays killable and the cursor is restored on the way out.
    if (input.includes('\u0003')) {
      void shutdown();
      return;
    }
    // Any interaction with the pane re-arms the hotkey hint.
    revealStatusHint();
    if (TOGGLE_KEYS.some((key) => input.includes(key))) {
      toggleDisplayMode();
      renderNow();
      return;
    }
    // `t` cycles tool details targets -> full -> off at runtime; the
    // environment variable only seeds the initial mode. Matched exactly: a
    // substring test fired on any paste or escape sequence containing a "t".
    if (input === 't' || input === 'T') {
      cycleToolDetailsMode();
    }
    renderNow();
  });
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const inactivityTimeoutMs = parseAgentInactivityTimeoutMs(
    process.env[AGENT_INACTIVITY_TIMEOUT_ENV]
  );
  agentActivityCollector = new AgentActivityCollector({ inactivityTimeoutMs });

  // Set up signal handlers
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGHUP', () => void shutdown());
  process.on('SIGUSR1', toggleDisplayMode);

  // Last-resort diagnostics: a stray throw or rejection escaping a timer or
  // watcher path must not kill the pane silently. remain-on-exit would leave
  // a dead pane visible, but a HUD that logs and keeps rendering is strictly
  // better than either.
  process.on('uncaughtException', (error) => {
    logHudError('uncaught-exception', error);
  });
  process.on('unhandledRejection', (reason) => {
    logHudError('unhandled-rejection', reason);
  });

  // Handle stdin close (tmux pane closed)
  process.stdin.on('close', () => void shutdown());
  process.stdin.resume();
  setupKeyListener();

  // Repaint immediately on pane resize instead of waiting out the current
  // refresh interval; the invalidation forces a full-screen clear so no
  // artifacts of the old geometry survive.
  process.stdout.on('resize', () => {
    noteWakeSignal();
    invalidateRenderedFrame();
    renderNow();
  });

  // Set up file watchers
  hudFileWatcher.onConfigChange(() => {
    noteWakeSignal();
    void refreshSlowProject(true);
  });

  hudFileWatcher.onRolloutChange(async (rolloutPath) => {
    // Any rollout appearing or changing (bound or not) is activity: it ends
    // deep idle so a /new session in the pane is rebound at base cadence.
    noteWakeSignal();
    // A new rollout file may establish a freshly created (/new) session;
    // let the finder re-rank it immediately instead of waiting out the poll.
    await sessionFinder.noteRolloutAppeared(rolloutPath);
    void sessionFinder.check();
    await refreshRolloutAndAgents();
    if (displayMode === 'overview') {
      // Respect the snapshot TTL: with a working session watcher these
      // events can arrive in bursts across every active session.
      void overviewCache.refresh().catch(() => {
        // Keep the previous overview snapshot.
      });
    }
  });

  hudFileWatcher.start();
  sessionFinder.start(5000); // Check for session changes every 5 seconds

  // Paint a provisional frame immediately; the initial collector round used
  // to gate the first frame (~940ms measured, longer under load) and the
  // pane stayed blank for that whole time.
  renderNow();
  await Promise.allSettled([
    gitCache.refresh(true),
    refreshSlowProject(true),
    ...(displayMode === 'overview' ? [overviewCache.refresh(true)] : []),
  ]);
  startCollectorTimers();

  // Start the render loop
  await mainLoop();
}

// Run main
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
