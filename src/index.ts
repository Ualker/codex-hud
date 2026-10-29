import { isRootRolloutForCwd } from './utils/rollout-wake.js';
import { publishDiagnostics } from './utils/diagnostics.js';
import { loadPreferences, savePreferences, normalizePreferences, filteredSessions, moveSelection, focusSession } from './ui/state.js';
import { installFatalHandlers } from './utils/fatal-error.js';
/**
 * Codex HUD - Main entry point
 * Phase 3: Redesigned with claude-hud style rendering
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as crypto from 'crypto';
import {
  collectGitStatusAsync,
  emptyGitStatus,
} from './collectors/git.js';
import { SessionFinder } from './collectors/session-finder.js';
import {
  AgentActivityCollector,
  AGENT_INACTIVITY_TIMEOUT_ENV,
  parseAgentInactivityTimeoutMs,
} from './collectors/agent-activity.js';
import { RolloutParser } from './collectors/rollout.js';
import {
  collectSlowProjectSnapshot,
  type SlowProjectSnapshot,
} from './collectors/slow-project.js';
import {
  publishHudBinding,
} from './collectors/open-huds.js';
import {
  findLatestAccountRateLimits,
  preferFreshestRateLimits,
  type AccountRateLimits,
} from './collectors/account-limits.js';
import { OverviewCollector } from './collectors/overview.js';
import { QuotaTrendTracker } from './collectors/quota-trend.js';
import { ApprovalDetector } from './collectors/approval-detector.js';
import { StallDetector } from './collectors/stall-detector.js';
import { CodexLivenessProbe, isLivenessProbeCandidate } from './collectors/codex-liveness.js';
import { extractCodexCliPolicy } from './collectors/runtime-hooks.js';
import { FreshPromptDetector } from './collectors/fresh-prompt-detector.js';
import { withDetectorPhases } from './utils/detector-phases.js';
import { createParseQueue } from './utils/parse-queue.js';
import { AsyncSnapshotCache } from './utils/async-snapshot-cache.js';
import { HeightFitPolicy } from './utils/height-fit.js';
import { slowProbes, getProbeDiagnostics } from './utils/probe-latency.js';
import { getSqliteDiagnostics } from './utils/sqlite-probe.js';
import { createMouseInputParser } from './utils/mouse-input.js';
import { getCodexDataNamespace } from './utils/codex-path.js';
import {
  readSharedSnapshot,
  writeSharedSnapshot,
} from './utils/shared-snapshot.js';
import {
  applyPaneHeight,
  readPaneHeightSettings,
} from './collectors/pane-height.js';
import {
  GIT_SLOW_MS,
  planCadence,
  type CadencePlan,
} from './utils/idle-policy.js';
import { HudFileWatcher } from './collectors/file-watcher.js';
import {
  renderToStdout,
  cleanupRenderer,
  enableMouseReporting,
  invalidateRenderedFrame,
  renderFallbackFrame,
  revealStatusHint,
  isViewToggleClick,
} from './render/index.js';
import {
  cycleToolDetailsMode,
  setToolDetailsMode,
  toolDetailsMode,
  rateLimitAlertKind,
} from './render/lines/activity-line.js';
import { toggleHudDetails, setHudDetails, hudDetailsExpanded } from './render/detail-level.js';
import { HudNotifier, isCompletedTurnNotifiable, stopNotifications } from './notify.js';
import { logHudError } from './utils/hud-log.js';
import { recordCollectorFailure } from './utils/collector-health.js';
import { resolveHudStateFile } from './utils/state-dir.js';
import { buildContextUsage } from './context-usage.js';
import type {
  HudData,
  CodexConfig,
  GitStatus,
  HudDisplayMode,
  SessionOverview,
  CollectorHealth,
  CollectorHealthMap,
  ProjectInfo,
  TurnActivity,
} from './types.js';

// Session start time
const SESSION_START = new Date();

/**
 * The build this process is running, frozen at spawn. Nine rounds of
 * rebuilds made "are the running HUDs current?" a literal user question that
 * took process-age-versus-mtime forensics to answer; a slow mtime poll on
 * this file answers it on the pane instead. A failed initial stat disables
 * the check rather than ever guessing.
 */
const HUD_ENTRY_PATH = fileURLToPath(import.meta.url);
const initialBuildMtimeMs: number | null = (() => {
  try {
    return fs.statSync(HUD_ENTRY_PATH).mtimeMs;
  } catch {
    return null;
  }
})();
let hudBuildUpdated = false;
const BUILD_CHECK_INTERVAL_MS = 60_000;
let lastBuildCheckMs = Date.now();

function checkBuildFreshness(): void {
  if (initialBuildMtimeMs === null) {
    return;
  }
  try {
    hudBuildUpdated =
      fs.statSync(HUD_ENTRY_PATH).mtimeMs !== initialBuildMtimeMs;
  } catch {
    // Mid-rebuild the file can be briefly absent; that proves nothing about
    // which build is newer, so keep the previous answer.
  }
}

// Refresh intervals come from the cadence policy (utils/idle-policy.ts);
// this is only the fallback used when a render tick itself throws.
const RENDER_ERROR_RETRY_INTERVAL = 1500;
const GIT_CACHE_TTL_MS = 5000;
// Account-wide rate limits change only when some session on this machine
// completes a turn, so a slow poll is enough; deep idle stretches it further.
const ACCOUNT_LIMITS_TTL_MS = 60_000;
const ACCOUNT_LIMITS_INTERVAL_MS = 60_000;
const ACCOUNT_LIMITS_DEEP_IDLE_INTERVAL_MS = 5 * 60_000;
const PROJECT_CACHE_TTL_MS = 60_000;
const OVERVIEW_CACHE_TTL_MS = 5000;

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
let accountLimitsRefreshTimer: NodeJS.Timeout | null = null;
let overviewRefreshTimer: NodeJS.Timeout | null = null;
let agentRefreshTimer: NodeJS.Timeout | null = null;
let rolloutFallbackTimer: NodeJS.Timeout | null = null;
let approvalRefreshTimer: NodeJS.Timeout | null = null;

// Display mode (single vs overview)
let displayMode: HudDisplayMode =
  process.env.CODEX_HUD_MODE === 'overview' ? 'overview' : 'single';

const TOGGLE_KEYS = ['\u0014']; // Ctrl+T

// Local wake signals (keypresses, toggles, resizes, watcher events) count as
// activity for the cadence policy, so an idle HUD being interacted with — or
// a fresh rollout appearing anywhere — snaps back to the base cadence.
let lastWakeSignalMs = Date.now();

// The pending render tick. A wake signal re-arms it: a deep-idle tick is
// three seconds, and the first event after a quiet stretch used to wait it
// out — Codex showed "Working" while the HUD still read "Idle · waiting for
// you" for up to four seconds.
let mainLoopTimer: NodeJS.Timeout | null = null;
let mainLoopDueAtMs = 0;
const WAKE_RESCHEDULE_MS = 100;
const RENDER_ACTIVE_TICK_MS = 500;

function scheduleMainLoop(delayMs: number): void {
  if (mainLoopTimer) {
    clearTimeout(mainLoopTimer);
  }
  mainLoopDueAtMs = Date.now() + delayMs;
  mainLoopTimer = setTimeout(() => {
    mainLoopTimer = null;
    void mainLoop();
  }, delayMs);
}

function noteWakeSignal(): void {
  lastWakeSignalMs = Date.now();
  // Only a slow tick is worth re-arming; the active cadence is already fast.
  if (
    mainLoopTimer &&
    mainLoopDueAtMs - lastWakeSignalMs > RENDER_ACTIVE_TICK_MS
  ) {
    scheduleMainLoop(WAKE_RESCHEDULE_MS);
  }
}

let uiPreferences = normalizePreferences({});
let helpVisible = false;
let helpPage = 0;
let overviewSelectionId: string | undefined;
let uiNotice: string | undefined;
let uiNoticeUntil = 0;
function persistUi(): void {
  uiPreferences = { ...uiPreferences, mode: displayMode, details: hudDetailsExpanded() ? 'full' : 'compact', tools: toolDetailsMode() };
  void savePreferences(HUD_TMUX_SESSION, uiPreferences);
}
function showUiNotice(message: string): void {
  uiNotice = message;
  uiNoticeUntil = Date.now() + 4000;
  renderNow();
}

function showModeNotice(): void {
  showUiNotice(`${displayMode} · ${hudDetailsExpanded() ? 'full' : 'compact'} · tools: ${toolDetailsMode()} · ${uiPreferences.layout}`);
}

function toggleDisplayMode(): void {
  noteWakeSignal();
  displayMode = displayMode === 'single' ? 'overview' : 'single';
  helpVisible = false;
  persistUi();
  showModeNotice();
  if (displayMode === 'overview') {
    void overviewCache.refresh(true).catch(() => {
      // Keep the previous overview snapshot.
    });
  }
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
    status: collectorHealth[name]?.status ?? 'pending',
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
  collectorHealth[name] = recordCollectorFailure(name, error, collectorHealth[name]);
}

const HUD_TMUX_SESSION = process.env.CODEX_HUD_TMUX_SESSION || undefined;
const approvalDetector = new ApprovalDetector({
  mainPane: process.env.CODEX_HUD_MAIN_PANE || undefined,
});
const stallDetector = new StallDetector({
  mainPane: process.env.CODEX_HUD_MAIN_PANE || undefined,
});
const codexLiveness = new CodexLivenessProbe({
  mainPane: process.env.CODEX_HUD_MAIN_PANE || undefined,
});
const freshPromptDetector = new FreshPromptDetector({
  mainPane: process.env.CODEX_HUD_MAIN_PANE || undefined,
});
// Edge-triggered outbound notifications (CODEX_HUD_NOTIFY_CMD); inert unless
// the user configured a command.
const notifier = new HudNotifier();

let bindingGeneration = 0;
const sessionFinder = new SessionFinder(HUD_CWD_REAL, (session) => {
  if (isShuttingDown) return;
  bindingGeneration++;
  const rolloutSession = session && fs.existsSync(session.path) ? session : null;
  approvalDetector.reset();
  stallDetector.reset();
  codexLiveness.reset();
  freshPromptDetector.reset();
  notifier.reset();
  // Let other HUDs' overviews see this binding. A session bound before its
  // first turn has no rollout yet, which is exactly the case file timestamps
  // cannot represent.
  void publishHudBinding(
    HUD_TMUX_SESSION,
    session?.sessionId ?? null,
    rolloutSession?.path ?? null,
    HUD_CWD,
    false,
    false,
    false,
    false,
    uiPreferences.label
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
// A config that fails to parse keeps serving the last one that did.
let lastGoodConfig: CodexConfig = {};
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
      const snapshot = await collectSlowProjectSnapshot(
        HUD_CWD,
        {
          runtimeHookOverrides: sessionFinder.getRuntimeHookOverrides(),
          runtimeHooksEnabled: sessionFinder.getRuntimeHooksEnabled(),
          forceAssetRefresh,
        },
        lastGoodConfig
      );
      if (!snapshot.configError) {
        lastGoodConfig = snapshot.config;
      }
      return snapshot;
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
/**
 * Newest rate-limit snapshot written by any session on this machine.
 *
 * Deliberately not wired into collectorHealth: when this scan fails the HUD
 * falls back to the bound session's own snapshot, which is a well-defined
 * degradation rather than a fault worth spending a warning row on.
 */
// Several HUDs scanning the same account is the same answer found several
// times; whichever scans first shares it (utils/shared-snapshot.ts).
const CODEX_DATA_NAMESPACE = getCodexDataNamespace();
const ACCOUNT_LIMITS_SHARE = `account-limits-${CODEX_DATA_NAMESPACE}`;
function reviveAccountLimits(raw: unknown): AccountRateLimits | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const { limits, observedAt } = raw as Record<string, unknown>;
  if (typeof limits !== 'object' || limits === null || typeof observedAt !== 'string') {
    return null;
  }
  const at = new Date(observedAt);
  return Number.isFinite(at.getTime())
    ? { limits: limits as AccountRateLimits['limits'], observedAt: at }
    : null;
}
const accountLimitsCache = new AsyncSnapshotCache<AccountRateLimits | null>(
  null,
  async () => {
    const shared = readSharedSnapshot(
      ACCOUNT_LIMITS_SHARE,
      ACCOUNT_LIMITS_TTL_MS,
      reviveAccountLimits
    );
    if (shared) {
      return shared;
    }
    const fresh = await findLatestAccountRateLimits();
    if (fresh) {
      writeSharedSnapshot(ACCOUNT_LIMITS_SHARE, {
        limits: fresh.limits,
        observedAt: fresh.observedAt.toISOString(),
      });
    }
    return fresh;
  },
  { ttlMs: ACCOUNT_LIMITS_TTL_MS, staleAfterMs: ACCOUNT_LIMITS_TTL_MS * 10 }
);
// Two observed readings of the current quota window; the burn-rate slope
// between them projects the exhaustion the level alone cannot warn about.
// The baseline is shared through a state file so every HUD forecasts the
// account the same way and a --reload does not restart the clock.
const quotaTrend = new QuotaTrendTracker({
  stateFilePath: resolveHudStateFile(`quota-trend-${CODEX_DATA_NAMESPACE}.json`),
});
// One `git status` per repository per cadence across HUDs, not per HUD.
const GIT_SHARE = `git-${crypto
  .createHash('md5')
  .update(HUD_CWD_REAL)
  .digest('hex')
  .slice(0, 12)}`;
function reviveGitStatus(raw: unknown): GitStatus | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const status = raw as Record<string, unknown>;
  return typeof status.isGitRepo === 'boolean' &&
    typeof status.isDirty === 'boolean' &&
    (status.branch === null || typeof status.branch === 'string')
    ? (raw as GitStatus)
    : null;
}
const gitCache = new AsyncSnapshotCache(
  emptyGitStatus(),
  async () => {
    const shared = readSharedSnapshot(GIT_SHARE, GIT_CACHE_TTL_MS, reviveGitStatus);
    if (shared) {
      return shared;
    }
    const fresh = await collectGitStatusAsync(HUD_CWD);
    writeSharedSnapshot(GIT_SHARE, fresh);
    return fresh;
  },
  {
    ttlMs: GIT_CACHE_TTL_MS,
    // The cadence policy legitimately stretches git refreshes to GIT_SLOW_MS
    // (deep idle / non-repo cwd); "stale" must mean a refresh actually missed
    // its schedule, not that the slow schedule is in effect. Real failures
    // still surface immediately through the error status.
    staleAfterMs: GIT_SLOW_MS * 1.5,
  }
);

const overviewCollector = new OverviewCollector();
async function refreshOverviewData(): Promise<SessionOverview> {
  return overviewCollector.refresh([
    overviewSelectionId,
    sessionFinder.getCurrentSession()?.sessionId,
    ...overviewCache.get().sessions.slice(0, 8).map(row => row.id),
  ].filter((id): id is string => Boolean(id)));
}

const overviewCache = new AsyncSnapshotCache<SessionOverview>(
  { sessions: [], updatedAt: new Date(0) },
  refreshOverviewData,
  {
    ttlMs: OVERVIEW_CACHE_TTL_MS,
    // Deep idle refreshes every 30s; allow a slow tmux probe before warning.
    staleAfterMs: 45_000,
  }
);

async function publishCurrentHudBinding(): Promise<void> {
  if (isShuttingDown) return;
  const session = sessionFinder.getCurrentSession();
  const rolloutSession =
    session && fs.existsSync(session.path) ? session : null;
  await publishHudBinding(
    HUD_TMUX_SESSION,
    session?.sessionId ?? null,
    rolloutSession?.path ?? null,
    HUD_CWD,
    approvalDetector.isApprovalNeeded(),
    stallDetector.isLikelyInterrupted(),
    codexLiveness.isCodexGone(),
    freshPromptDetector.isPaneOnFreshSession(),
    uiPreferences.label
  );
}

/**
 * Pane probing (approval waits and stream-error stalls) stays outside both
 * the render clock and rollout parser. Each detector performs no tmux capture
 * until the persisted structure has stalled; each owns its own low-frequency
 * gate after that point.
 */
async function refreshPaneDetectors(): Promise<void> {
  const rolloutData = rolloutParser.getCached();
  const runtimePolicy = rolloutData?.session?.approvalPolicy;
  // Launch flags outrank the config file; the liveness capture is the only
  // witness for them while the session has no records.
  const codexCommand = codexLiveness.getCodexCommand();
  const cliApprovalPolicy = codexCommand
    ? extractCodexCliPolicy(codexCommand).approvalPolicy
    : undefined;
  const [approvalChanged, stallChanged, livenessChanged, freshChanged] =
    await Promise.all([
      approvalDetector.refresh({
        turnActivity: rolloutData?.turnActivity,
        toolActivity: rolloutData?.toolActivity,
        lastEventAt: rolloutData?.lastEventTime,
        approvalPolicy: runtimePolicy ?? cliApprovalPolicy,
      }),
      stallDetector.refresh({
        turnActivity: rolloutData?.turnActivity,
        lastEventAt: rolloutData?.lastEventTime,
      }),
      codexLiveness.refresh({
        turnActivity: rolloutData?.turnActivity,
        lastEventAt: rolloutData?.lastEventTime,
      }),
      freshPromptDetector.refresh({
        turnActivity: rolloutData?.turnActivity,
        lastEventAt: rolloutData?.lastEventTime,
      }),
    ]);
  const changed =
    approvalChanged || stallChanged || livenessChanged || freshChanged;
  if (!changed) {
    return;
  }

  // Publish first so this HUD and every other overview read the same state.
  // A failed publish only delays overview propagation; the owning single view
  // already renders from the local detector cache.
  try {
    await publishCurrentHudBinding();
  } catch {
    // The overview falls back to rollout-only state.
  }
  if (displayMode === 'overview') {
    try {
      await overviewCache.refresh(true);
    } catch {
      // Keep the previous overview snapshot.
    }
  }
  renderNow();
}

// Newest tool completion already reflected in the git snapshot. Codex's own
// edits are what change the repository during a session, and the call that
// made them completing is the moment the dirty marker should move.
let lastToolCompletionMs = 0;

function noteToolCompletions(): void {
  const calls = rolloutParser.getCached()?.toolActivity.recentCalls ?? [];
  let newest = lastToolCompletionMs;
  for (const call of calls) {
    if (call.status === 'running') {
      continue;
    }
    const finishedAt = call.timestamp.getTime() + (call.duration ?? 0);
    if (finishedAt > newest) {
      newest = finishedAt;
    }
  }
  if (newest > lastToolCompletionMs) {
    lastToolCompletionMs = newest;
    // The cache TTL coalesces a burst of completions into one spawn.
    void gitCache.refresh().catch(() => {
      // Cache health is rendered from the retained last-good snapshot.
    });
  }
}

/**
 * Parse rollout updates outside the render clock. Returns false when there is
 * no bound rollout or the parse failed. A parse that changed the result paints
 * at once: the state used to sit in the cache until the next render tick,
 * which is up to three seconds in deep idle.
 */
async function refreshRolloutOnly(): Promise<boolean> {
  const generation = bindingGeneration;
  const session = sessionFinder.getCurrentSession();
  if (!session || !fs.existsSync(session.path)) {
    cachedAgentActivity = undefined;
    return false;
  }

  recordCollectorAttempt('rollout');
  const before = rolloutParser.getCached();
  try {
    await parseRolloutSafely();
    if (generation !== bindingGeneration) return false;
    recordCollectorSuccess('rollout');
  } catch (error) {
    if (generation !== bindingGeneration) return false;
    recordCollectorError('rollout', error);
    return false;
  }
  if (rolloutParser.getCached() !== before) {
    noteToolCompletions();
    renderNow();
  }
  return true;
}

/**
 * Parse watcher-driven rollout and agent updates outside the render clock.
 */
async function refreshRolloutAndAgents(): Promise<void> {
  if (await refreshRolloutOnly()) {
    await refreshAgents();
    renderNow();
  }
}

function refreshAgents(): Promise<void> {
  if (agentRefreshInFlight) {
    return agentRefreshInFlight;
  }

  const generation = bindingGeneration;
  const request = (async () => {
    const session = sessionFinder.getCurrentSession();
    if (!session || !fs.existsSync(session.path)) {
      cachedAgentActivity = undefined;
      return;
    }
    recordCollectorAttempt('agents');
    try {
      const activity = await agentActivityCollector.collect(Date.now());
      if (generation !== bindingGeneration) return;
      cachedAgentActivity = activity;
      recordCollectorSuccess('agents');
    } catch (error) {
      if (generation !== bindingGeneration) return;
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
    layoutPreset: uiPreferences.layout,
    sessionLabel: uiPreferences.label,
    helpVisible,
    helpPage,
    uiNotice: Date.now() < uiNoticeUntil ? uiNotice : undefined,
    overviewFilter: uiPreferences.filter,
    overviewSelectionId,
    config: slowData.config,
    git: gitCache.get(),
    project: slowData.project,
    sessionStart: SESSION_START,
    ...(hudBuildUpdated ? { hudBuildUpdated: true } : {}),
    slowProbes: slowProbes(),
    collectorHealth: {
      ...collectorHealth,
      ...slowCollectorHealth,
      git: gitCache.getHealth(),
      ...overviewHealth,
    },
  };

  const session = sessionFinder.getCurrentSession();
  const rolloutData = rolloutParser.getCached();

  // Build context usage from token usage if available
  // Matches codex "context window left" calculation based on last_token_usage.
  const contextUsage = buildContextUsage(
    rolloutData?.tokenUsage ?? undefined,
    rolloutData?.compactCount,
    rolloutData?.lastCompactTime
  );
  const accountLimits = accountLimitsCache.get();
  const rateLimits = preferFreshestRateLimits(
    rolloutData?.rateLimits,
    rolloutData?.rateLimitsAt,
    accountLimits
  );
  // Pure memory: both sources feed the trend so the baseline builds from
  // every dated reading, not just whichever snapshot wins the display.
  quotaTrend.observe(rolloutData?.rateLimits, rolloutData?.rateLimitsAt);
  quotaTrend.observe(accountLimits?.limits, accountLimits?.observedAt);
  const quotaProjections = quotaTrend.projectAll(rateLimits) ?? undefined;
  const boundSession = rolloutData?.session ?? session?.metadata ?? undefined;
  const quotaFromAccount = rateLimits === accountLimits?.limits;
  const freshness = { rateLimitsSource: quotaFromAccount ? 'account logs' : 'session log',
    rateLimitsObservedAt: (quotaFromAccount ? accountLimits?.observedAt : rolloutData?.rateLimitsAt) ?? undefined,
    pendingBytes: rolloutData?.pendingBytes };
  const codexExited = codexLiveness.isCodexGone() && isLivenessProbeCandidate({
    turnActivity: rolloutData?.turnActivity, lastEventAt: rolloutData?.lastEventTime,
  });
  const turnActivity = withDetectorPhases(
    rolloutData?.turnActivity,
    approvalDetector.isApprovalNeeded(),
    stallDetector.isLikelyInterrupted(),
    codexExited,
    rolloutData?.lastEventTime ?? undefined
  );

  if (displayMode === 'overview') {
    return {
      ...baseData,
      ...freshness,
      displayMode,
      overview: overviewCache.get(),
      // Lets the overview mark the row this HUD is bound to.
      overviewSelfSessionId: session?.sessionId,
      // The overview states the account quota, which belongs to every row at
      // once, and lists the bound session before the scan finishes. Both read
      // the same already-collected values the single view uses; leaving them
      // off made both features render nothing in a real pane while unit
      // fixtures that supplied them by hand still passed.
      session: boundSession,
      turnActivity,
      contextUsage,
      rateLimits,
      quotaProjections,
      ...(codexExited ? { codexExited: true } : {}),
    };
  }

  // The pane's live invocation carries launch flags the config file cannot
  // see; while the bound session has no records they are the only truth.
  const codexCommand = codexLiveness.getCodexCommand();
  const cliPolicy = codexCommand
    ? extractCodexCliPolicy(codexCommand)
    : undefined;
  const paneCliPolicy =
    cliPolicy &&
    (cliPolicy.approvalPolicy ||
      cliPolicy.sandboxMode ||
      // Retain argv provenance for diagnostics; it does not certify config.
      cliPolicy.exhaustive)
      ? cliPolicy
      : undefined;

  return {
    ...baseData,
    ...freshness,
    session: boundSession,
    toolActivity: rolloutData?.toolActivity ?? undefined,
    agentActivity: cachedAgentActivity,
    planProgress: rolloutData?.planProgress ?? undefined,
    tokenUsage: rolloutData?.tokenUsage ?? undefined,
    rateLimits,
    quotaProjections,
    turnActivity,
    protocolHealth: rolloutData?.protocolHealth,
    ...(codexExited ? { codexExited: true } : {}),
    ...(freshPromptDetector.isPaneOnFreshSession()
      ? { paneFreshSession: true }
      : {}),
    ...(paneCliPolicy ? { paneCliPolicy } : {}),
    ...(session && !rolloutData ? { boundWithoutRollout: true } : {}),
    partialHistory: rolloutData?.partialHistory,
    runtimeStateComplete: rolloutData?.runtimeStateComplete,
    contextUsage,
    displayMode,
  };
}

function isWorkingPhase(phase: string | undefined): boolean {
  // A confirmed-interrupted turn is dead, not working: it must not pin the
  // base cadence (or the overview's "working" rank) the way a live one does.
  return (
    phase !== undefined &&
    phase !== 'awaiting-approval' &&
    phase !== 'idle' &&
    phase !== 'aborted' &&
    phase !== 'failed' &&
    phase !== 'interrupted' &&
    phase !== 'exited'
  );
}

/**
 * Current cadence plan derived from live collector state. Cheap enough to
 * evaluate on every render tick and timer tick.
 */
function computeCadence(nowMs: number = Date.now()): CadencePlan {
  const rolloutData = rolloutParser.getCached();
  const session = sessionFinder.getCurrentSession();
  const approvalNeeded = approvalDetector.isApprovalNeeded();
  const phase = withDetectorPhases(
    rolloutData?.turnActivity,
    approvalNeeded,
    stallDetector.isLikelyInterrupted(),
    codexLiveness.isCodexGone(),
    rolloutData?.lastEventTime ?? undefined,
    nowMs
  )?.phase;
  const hasRunningTool =
    phase !== 'exited' && !approvalNeeded &&
    ((rolloutData?.toolActivity?.runningCalls ?? rolloutData?.toolActivity?.recentCalls)?.some(
      (call) => call.status === 'running'
    ) ?? false);
  const hasActiveTurn = isWorkingPhase(phase);
  const hasActiveAgent = (cachedAgentActivity?.visibleAgentCount ?? 0) > 0;
  let lastActivityMs = Math.max(
    lastWakeSignalMs,
    rolloutData?.lastEventTime?.getTime() ?? 0,
    rolloutData?.turnActivity?.lastActivityAt.getTime() ?? 0,
    session?.modifiedAt.getTime() ?? 0
  );

  // While the dashboard is up, the sessions on it are the ones being watched,
  // and none of them is the bound session. Backing off has to account for
  // their activity or a user watching a busy fleet would see it go slack.
  //
  // A session killed mid-turn leaves a rollout whose last phase never becomes
  // idle, so it reads as working until it ages out. That delays the backoff
  // but cannot prevent it: such a session leaves the overview's activity
  // window half an hour after its last write.
  const overviewVisible = displayMode === 'overview';
  let overviewWorking = false;
  if (overviewVisible) {
    for (const item of overviewCache.get().sessions) {
      if (item.unavailable || item.freshPrompt) continue;
      overviewWorking ||= isWorkingPhase(item.turnActivity?.phase);
      lastActivityMs = Math.max(
        lastActivityMs,
        item.lastActivityAt?.getTime() ?? 0
      );
    }
  }

  return planCadence({
    nowMs,
    lastActivityMs,
    hasActiveWork:
      hasRunningTool || hasActiveTurn || hasActiveAgent || overviewWorking,
    bound: session !== null,
    overviewVisible,
    gitIsRepo: gitCache.get().isGitRepo,
  });
}

// Content-fitted pane height (utils/height-fit.ts). Null until the tmux
// sizing policy has been read and says the wrapper's adaptive mode is on;
// an explicit CODEX_HUD_HEIGHT or CODEX_HUD_HEIGHT_FIT=0 leaves it null.
let heightFit: HeightFitPolicy | null = null;
let heightFitInFlight = false;
const HUD_PANE_ID = process.env.TMUX_PANE || undefined;

async function setupHeightFit(): Promise<void> {
  if (
    process.env.CODEX_HUD_HEIGHT_FIT === '0' ||
    !HUD_TMUX_SESSION ||
    !HUD_PANE_ID
  ) {
    return;
  }
  const settings = await readPaneHeightSettings(HUD_TMUX_SESSION);
  if (!settings || !settings.adaptive) {
    return;
  }
  heightFit = new HeightFitPolicy({
    minRows: settings.minRows,
    maxRows: settings.maxRows,
    initialRows: settings.initialRows,
    manualRows: settings.manualRows,
  });
}

function fitPaneHeight(wantedRows: number, height: number): void {
  if (!heightFit || heightFitInFlight || !HUD_TMUX_SESSION || !HUD_PANE_ID) {
    return;
  }
  const rows = heightFit.observe(wantedRows, height, Date.now());
  if (rows === null) {
    return;
  }
  heightFitInFlight = true;
  void applyPaneHeight(HUD_TMUX_SESSION, HUD_PANE_ID, rows)
    .catch(() => false)
    .finally(() => {
      heightFitInFlight = false;
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
    const data = collectData();
    const { wantedRows, height } = renderToStdout(data);
    fitPaneHeight(wantedRows, height);
    delete collectorHealth.renderer;
    // Observed after the frame so a notification can never precede the pane
    // stating the same thing. Rising edges only; see notify.ts.
    const lastTurnMs = data.turnActivity?.lastTurnDurationMs;
    if ((data.pendingBytes ?? 0) < 1024 * 1024) notifier.observe(
      {
        'approval-needed': data.turnActivity?.phase === 'awaiting-approval',
        'turn-interrupted': data.turnActivity?.phase === 'interrupted',
        'limit-reached': rateLimitAlertKind(data.rateLimits, Date.now()) !== null,
        'turn-completed': isCompletedTurnNotifiable(
          data.turnActivity?.phase,
          lastTurnMs
        ),
        'turn-failed': data.turnActivity?.phase === 'failed',
      },
      {
        sessionId: sessionFinder.getCurrentSession()?.sessionId,
        turnId: data.turnActivity?.turnId,
        tmuxSession: HUD_TMUX_SESSION,
        cwd: HUD_CWD,
        lastTurnDurationMs: lastTurnMs,
        lastTurnError: data.turnActivity?.lastTurnError,
      }
    );
    publishDiagnostics(HUD_TMUX_SESSION, {namespace:getCodexDataNamespace(),binding:sessionFinder.getDiagnostics(),
      probes:getProbeDiagnostics(),sqlite:getSqliteDiagnostics(),overview:overviewCollector.getDiagnostics(),
      rollout:rolloutParser.getDiagnostics(),cliVersion:data.session?.cliVersion,
      collectors:data.collectorHealth,protocol:data.protocolHealth,
      quota:{source:data.rateLimitsSource,observedAt:data.rateLimitsObservedAt},
      preferences:uiPreferences,mainPane:process.env.CODEX_HUD_MAIN_PANE});
    const plan = computeCadence();
    sessionFinder.setDeepIdle(plan.deepIdle);
    scheduleMainLoop(plan.renderMs);
  } catch (error) {
    // stderr would land inside the rendered frame, so diagnostics go to the
    // log file. That is not enough on its own: the screen keeps whatever was
    // painted last, which reads as a healthy idle session. Say so in the pane.
    recordCollectorError('renderer', error);
    renderFallbackFrame(
      collectorHealth.renderer?.errorSummary ?? 'unknown error'
    );
    scheduleMainLoop(RENDER_ERROR_RETRY_INTERVAL);
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
  stopNotifications();

  if (mainLoopTimer) {
    clearTimeout(mainLoopTimer);
    mainLoopTimer = null;
  }
  if (gitRefreshTimer) {
    clearInterval(gitRefreshTimer);
  }
  if (projectRefreshTimer) {
    clearInterval(projectRefreshTimer);
  }
  if (accountLimitsRefreshTimer) {
    clearInterval(accountLimitsRefreshTimer);
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
  if (approvalRefreshTimer) {
    clearInterval(approvalRefreshTimer);
  }
  sessionFinder.stop();
  await Promise.allSettled([hudFileWatcher.stop()]);
  await publishHudBinding(HUD_TMUX_SESSION, null, null, HUD_CWD);
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
  let lastOverviewRefreshMs = 0;
  let lastAccountLimitsRefreshMs = Date.now();

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
    const now = Date.now();
    if (now - lastBuildCheckMs >= BUILD_CHECK_INTERVAL_MS) {
      lastBuildCheckMs = now;
      checkBuildFreshness();
    }
  }, 5000);
  accountLimitsRefreshTimer = setInterval(() => {
    const now = Date.now();
    const interval = computeCadence(now).deepIdle
      ? ACCOUNT_LIMITS_DEEP_IDLE_INTERVAL_MS
      : ACCOUNT_LIMITS_INTERVAL_MS;
    if (now - lastAccountLimitsRefreshMs < interval) {
      return;
    }
    lastAccountLimitsRefreshMs = now;
    void accountLimitsCache.refresh().catch(() => {
      // Falls back to the bound session's own snapshot.
    });
  }, 5000);
  overviewRefreshTimer = setInterval(() => {
    if (displayMode !== 'overview') {
      return;
    }
    const now = Date.now();
    if (now - lastOverviewRefreshMs < computeCadence(now).overviewMs) {
      return;
    }
    lastOverviewRefreshMs = now;
    void overviewCache.refresh().catch(() => {
      // Keep the previous overview snapshot.
    });
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
  approvalRefreshTimer = setInterval(() => {
    void refreshPaneDetectors();
  }, 1000);
}

function renderNow(): void {
  if (isShuttingDown) return;
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
  // With reporting on, tmux hands the wheel to this pane instead of entering
  // copy-mode over it, which froze the frame on screen.
  enableMouseReporting();
  const parseInput = createMouseInputParser(isViewToggleClick);
  const handleKey = (input: string): void => {
    // Raw mode suppresses the terminal's SIGINT; handle Ctrl+C explicitly so
    // the pane stays killable and the cursor is restored on the way out.
    if (input.includes('\u0003')) {
      void shutdown();
      return;
    }
    // Any interaction with the pane re-arms the hotkey hint.
    revealStatusHint();
    if (input === '\u001b[I') {
      showModeNotice();
      return;
    }
    if (input === '\u001b[O') return;
    if (input === '?') {
      helpVisible = !helpVisible;
      helpPage = 0;
      renderNow();
      return;
    }
    if (input === '\u001b') {
      if (helpVisible) {
        helpVisible = false;
        renderNow();
      } else {
        void focusSession(HUD_TMUX_SESSION).then(ok => {
          if (!ok) showUiNotice('Main pane unavailable');
        });
      }
      return;
    }
    const navigation = ['j', 'k', '\u001b[A', '\u001b[B'].includes(input);
    const direction = input === 'j' || input === '\u001b[B' ? 1 : -1;
    if (helpVisible && navigation) {
      helpPage += direction;
      renderNow();
      return;
    }
    if (input === 'c' || input === 'C') {
      uiPreferences.layout = uiPreferences.layout === 'standard' ? 'coexist' : 'standard';
      persistUi();
      showModeNotice();
      return;
    }
    if (displayMode === 'overview') {
      const rows = filteredSessions(overviewCache.get().sessions, uiPreferences.filter);
      if (input === 'f' || input === 'F') {
        uiPreferences.filter = uiPreferences.filter === 'all' ? 'attention' : 'all';
        overviewSelectionId = undefined;
        persistUi();
        showUiNotice(`Overview: ${uiPreferences.filter}`);
        return;
      }
      if (navigation) {
        overviewSelectionId = moveSelection(rows,
          overviewSelectionId ?? sessionFinder.getCurrentSession()?.sessionId, direction);
        renderNow();
        return;
      }
      if (input === '\r' || input === '\n') {
        const selectedId = overviewSelectionId ?? sessionFinder.getCurrentSession()?.sessionId;
        const selected = rows.find(row => row.tmuxSession && row.id === selectedId) ?? rows.find(row => row.tmuxSession);
        void focusSession(selected?.tmuxSession, selected?.id).then(ok => {
          if (!ok) {
            showUiNotice('Session unavailable; refreshing overview');
            void overviewCache.refresh(true).catch(() => undefined);
          }
        });
        return;
      }
    }
    if (TOGGLE_KEYS.includes(input)) {
      toggleDisplayMode();
      return;
    }
    if (input === 't' || input === 'T') {
      cycleToolDetailsMode();
    } else if (input === 'd' || input === 'D') {
      toggleHudDetails();
    } else {
      return;
    }
    persistUi();
    showModeNotice();
  };
  let escapeTimer: NodeJS.Timeout | undefined;
  process.stdin.on('data', (data: Buffer) => {
    noteWakeSignal();
    if (escapeTimer) clearTimeout(escapeTimer);
    const { mouse, keys } = parseInput(data.toString('utf8'));
    revealStatusHint();
    if (mouse.handled) {
      if (mouse.click) toggleDisplayMode();
      else showModeNotice();
    }
    // A transport read can contain several key presses. Only recognize a
    // complete stream of HUD keys; arbitrary pasted text is never a command.
    const tokens = keys.match(/\u001b\[[ABIO]|[?cdtfjkCDTFJK\r\n\u0003\u0014]/g) ?? [];
    if (tokens.join('') === keys) {
      for (const key of tokens) handleKey(key);
    }
    escapeTimer = setTimeout(() => {
      if (parseInput.flush() === '\u001b') handleKey('\u001b');
    }, 80);
  });
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  uiPreferences=await loadPreferences(HUD_TMUX_SESSION);
  displayMode=uiPreferences.mode;
  setHudDetails(uiPreferences.details==='full');
  setToolDetailsMode(uiPreferences.tools);
  await savePreferences(HUD_TMUX_SESSION,uiPreferences);
  const inactivityTimeoutMs = parseAgentInactivityTimeoutMs(
    process.env[AGENT_INACTIVITY_TIMEOUT_ENV]
  );
  agentActivityCollector = new AgentActivityCollector({ inactivityTimeoutMs });

  // Set up signal handlers
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGHUP', () => void shutdown());
  // Repaint immediately: the signal is the only toggle that does not go
  // through the key handler, and without this the view flipped but the pane
  // kept the old frame until the next tick — up to three seconds when idle.
  process.on('SIGUSR1', () => {
    toggleDisplayMode();
    renderNow();
  });
  // `codex-hud --cycle-details`: the `t` key without focusing the pane.
  process.on('SIGUSR2', () => {
    noteWakeSignal();
    cycleToolDetailsMode();
    persistUi();
    renderNow();
  });

  installFatalHandlers();

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
    const generation = bindingGeneration;
    const currentPath = sessionFinder.getCurrentSession()?.path;
    const candidate = rolloutPath !== currentPath && await isRootRolloutForCwd(rolloutPath,HUD_CWD_REAL);
    if (candidate) sessionFinder.setDeepIdle(false);
    await sessionFinder.noteRolloutAppeared(rolloutPath);
    await sessionFinder.check(candidate);
    const relevant = generation !== bindingGeneration ||
      rolloutPath === sessionFinder.getCurrentSession()?.path ||
      agentActivityCollector.isTrackedRollout(rolloutPath);
    if (relevant || candidate || displayMode === 'overview') noteWakeSignal();
    if (relevant) {
      await refreshRolloutAndAgents();
      void refreshPaneDetectors();
    }
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
  // None of the first rounds is awaited: the render loop used to wait for
  // git and the project scan, so a session bound in the meantime stayed off
  // the pane until both finished — seconds under load. Each paints on its
  // own when it lands; the health row stays silent while they are pending.
  void accountLimitsCache.refresh(true).catch(() => {
    // Falls back to the bound session's own snapshot.
  });
  void Promise.allSettled([
    gitCache.refresh(true),
    refreshSlowProject(true),
    ...(displayMode === 'overview' ? [overviewCache.refresh(true)] : []),
  ]).then(() => renderNow());
  void setupHeightFit();
  startCollectorTimers();

  // Start the render loop
  await mainLoop();
}

// Run main
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
