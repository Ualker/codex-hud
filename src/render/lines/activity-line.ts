/**
 * Activity Line Renderer
 * Renders: ◐ Edit: file.ts | ✓ Read ×3
 * Shows current and recent tool/agent activity
 */

import {
  theme,
  colors,
  remainingBar,
  icons,
  getSpinnerFrame,
  sanitizeTerminalText,
  truncate,
  truncateStart,
  truncateAnsi,
  visualLength,
} from '../colors.js';
import type {
  AgentActivity,
  AgentActivityRow,
  HudData,
  ToolActivity,
  ToolCall,
  PlanProgress,
  RateLimitWindow,
  TurnActivity,
} from '../../types.js';
import { isExecutionTool } from '../../utils/tool-names.js';
import { extractCommandHead } from '../../utils/command-head.js';
import {
  formatCompactAge,
  formatCompoundDuration,
} from '../../utils/format-age.js';
import { osc8Link, fileUrl } from '../../utils/hyperlinks.js';

const DESCENDANT_PREFIX = '↳';

type ToolDetailsMode = 'off' | 'targets' | 'full';

// Runtime override set by the `t` hotkey; the environment variable only
// provides the initial mode.
let toolDetailsModeOverride: ToolDetailsMode | null = null;

function toolDetailsMode(): ToolDetailsMode {
  if (toolDetailsModeOverride !== null) {
    return toolDetailsModeOverride;
  }
  const value = process.env.CODEX_HUD_TOOL_DETAILS;
  if (value === 'off' || value === 'full' || value === 'targets') {
    return value;
  }
  return 'targets';
}

const TOOL_DETAILS_MODE_ORDER: readonly ToolDetailsMode[] = [
  'targets',
  'full',
  'off',
];

// Cycling to `off` removes the tool row entirely; without a receipt the row
// just vanishes and there is nothing on screen saying which key brought it
// back. The notice occupies exactly the row the mode change affects.
const MODE_NOTICE_MS = 3000;
let modeNoticeUntilMs = 0;

/**
 * Cycle targets -> full -> off -> targets at runtime. Returns the new mode.
 */
export function cycleToolDetailsMode(nowMs: number = Date.now()): ToolDetailsMode {
  const current = toolDetailsMode();
  const next =
    TOOL_DETAILS_MODE_ORDER[
      (TOOL_DETAILS_MODE_ORDER.indexOf(current) + 1) %
        TOOL_DETAILS_MODE_ORDER.length
    ];
  toolDetailsModeOverride = next;
  modeNoticeUntilMs = nowMs + MODE_NOTICE_MS;
  return next;
}

/**
 * Transient confirmation of the current tool-details mode. Replaces the tool
 * row for a few seconds after `t`, so the row count stays put except while
 * the mode is `off` — the one case where the row would otherwise be gone.
 */
export function renderToolDetailsNotice(
  width: number = Number.POSITIVE_INFINITY,
  nowMs: number = Date.now()
): string | null {
  if (nowMs >= modeNoticeUntilMs) {
    return null;
  }
  return truncateAnsi(
    colors.dim(`tool details: ${toolDetailsMode()} · press t to cycle`),
    width
  );
}

/**
 * Tools whose display detail is a filesystem path. Paths carry their most
 * specific information at the end, so they truncate from the start.
 */
const PATH_DETAIL_TOOLS = new Set(['read', 'write', 'edit']);

function isPathDetailTool(toolName: string): boolean {
  return PATH_DETAIL_TOOLS.has(toolName.toLowerCase());
}

export function formatAgentElapsed(startedAt: Date, nowMs: number = Date.now()): string {
  const startedAtMs = startedAt.getTime();
  if (!Number.isFinite(startedAtMs)) {
    throw new Error('Agent elapsed startedAt must be a valid Date');
  }
  if (!Number.isFinite(nowMs)) {
    throw new Error('Agent elapsed nowMs must be finite');
  }

  // startedAt comes from rollout events written by another process; clock
  // skew can put it slightly in the future. Render "just started" instead of
  // failing the whole frame.
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    const seconds = elapsedSeconds % 60;
    return `${elapsedMinutes}m${seconds.toString().padStart(2, '0')}s`;
  }

  const hours = Math.floor(elapsedMinutes / 60);
  const minutes = elapsedMinutes % 60;
  return `${hours}h${minutes.toString().padStart(2, '0')}m`;
}

function renderAgentRow(
  icon: string,
  label: string,
  suffix: string,
  color: (text: string) => string,
  width: number
): string {
  const fixedWidth = visualLength(icon) + 1 + visualLength(suffix);
  const plain = width >= fixedWidth + 1
    ? `${icon} ${truncate(label, width - fixedWidth)}${suffix}`
    : `${icon} ${label}${suffix}`;
  return truncateAnsi(color(plain), width);
}

function renderAgentActivityRow(row: AgentActivityRow, width: number, nowMs: number): string {
  const safeLabel = sanitizeTerminalText(row.label) || 'agent';
  if (row.status === 'tracking-error') {
    return renderAgentRow(icons.cross, safeLabel, ' tracking error', theme.error, width);
  }
  // Unknown upstream statuses or a missing/invalid timer degrade to a visible
  // error row. Throwing here would fail renderHud every frame and blank the
  // whole HUD over one bad rollout record.
  if (
    (row.status !== 'starting' && row.status !== 'running') ||
    !row.elapsedStartedAt ||
    !Number.isFinite(row.elapsedStartedAt.getTime())
  ) {
    return renderAgentRow(icons.cross, safeLabel, ' display error', theme.error, width);
  }

  const spinnerIndex = Math.floor(nowMs / 100) % icons.spinner.length;
  const spinner = getSpinnerFrame(spinnerIndex);
  const elapsed = formatAgentElapsed(row.elapsedStartedAt, nowMs);
  const descendants = row.activeDescendantCount > 0
    ? ` ${DESCENDANT_PREFIX}${row.activeDescendantCount}`
    : '';
  return renderAgentRow(
    spinner,
    safeLabel,
    ` ${elapsed}${descendants}`,
    theme.agentRunning,
    width
  );
}

export function renderAgentLines(
  agentActivity: AgentActivity | undefined,
  width: number,
  nowMs: number = Date.now()
): string[] {
  if (!agentActivity) {
    return [];
  }
  if (agentActivity.rootTrackingError) {
    return [renderAgentRow(icons.cross, 'agent', ' tracking error', theme.error, width)];
  }
  return agentActivity.rows.map((row) => renderAgentActivityRow(row, width, nowMs));
}

/**
 * One-row stand-in for several agent rows, used when the pane cannot show all
 * of them. Collapsing keeps the fact that N agents are running — plain
 * truncation used to drop the extra agents *and* the plan row underneath them,
 * hiding the most work exactly when the most work was happening.
 *
 * Returns null when the rows carry per-row information a count cannot express
 * (errors), so the caller falls back to another compression step.
 */
export function renderAgentSummaryLine(
  agentActivity: AgentActivity | undefined,
  width: number,
  nowMs: number = Date.now()
): string | null {
  const rows = agentActivity?.rows;
  if (!agentActivity || agentActivity.rootTrackingError || !rows || rows.length < 2) {
    return null;
  }

  let oldestStartedAtMs = Number.POSITIVE_INFINITY;
  let descendants = 0;
  for (const row of rows) {
    if (row.status !== 'starting' && row.status !== 'running') {
      return null;
    }
    const startedAtMs = row.elapsedStartedAt?.getTime();
    if (startedAtMs === undefined || !Number.isFinite(startedAtMs)) {
      return null;
    }
    oldestStartedAtMs = Math.min(oldestStartedAtMs, startedAtMs);
    descendants += row.activeDescendantCount;
  }

  const spinner = getSpinnerFrame(
    Math.floor(nowMs / 100) % icons.spinner.length
  );
  const elapsed = formatAgentElapsed(new Date(oldestStartedAtMs), nowMs);
  const descendantSuffix = descendants > 0 ? ` ${DESCENDANT_PREFIX}${descendants}` : '';
  return truncateAnsi(
    theme.agentRunning(
      `${spinner} ${rows.length} agents ${elapsed}${descendantSuffix}`
    ),
    width
  );
}

/**
 * Shown while the HUD has no live turn state to display. Without it the HUD
 * silently renders three rows in a seven-row pane and a first-time user cannot
 * tell "waiting for Codex to start" apart from "the HUD is broken".
 *
 * Two distinct states reach this row. Codex creates a rollout lazily, on the
 * first turn, so a session can be bound and identified — its id comes from the
 * session store, not the rollout — while nothing has been written for the HUD
 * to read. Observed live on a session sitting at the prompt for 19 hours with
 * no rollout file anywhere on disk.
 */
export function renderBindingHintLine(
  data: HudData,
  width: number = Number.POSITIVE_INFINITY
): string | null {
  if (data.turnActivity) {
    return null;
  }
  // With Codex gone, both texts below become lies: nothing is starting and
  // nothing is waiting. Observed live — Codex quit at the trust prompt and
  // the pane kept saying "Waiting for a Codex session…".
  const message =
    data.codexExited === true
      ? 'Codex exited · run codex to restart'
      : data.session
        ? 'Session ready · no turns yet'
        : 'Waiting for a Codex session…';
  return truncateAnsi(colors.dim(`${icons.pending} ${message}`), width);
}

type ToolGroupStatus = 'completed' | 'error' | 'yielded';

interface ToolCallGroup {
  name: string;
  count: number;
  status: ToolGroupStatus;
  /** Command head of the group's most recent execution call, if any. */
  detail?: string;
}

function formatToolDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.max(0, Math.round(durationMs))}ms`;
  }

  const seconds = durationMs / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  }

  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remainingSeconds = wholeSeconds % 60;
  return `${minutes}m${remainingSeconds.toString().padStart(2, '0')}s`;
}

const formatAge = formatCompactAge;

function turnPhasePresentation(
  activity: TurnActivity,
  nowMs: number
): { label: string; icon: string; color: (text: string) => string } {
  switch (activity.phase) {
    case 'awaiting-approval':
      return {
        label: 'Approval needed',
        icon: icons.pause,
        color: theme.warning,
      };
    case 'thinking':
      return {
        label: `Thinking ${formatAge(nowMs - activity.since.getTime())}`,
        icon: getSpinnerFrame(Math.floor(nowMs / 100) % icons.spinner.length),
        color: theme.toolRunning,
      };
    case 'running-tool':
      return {
        label: `Running tool ${formatAge(nowMs - activity.since.getTime())}`,
        icon: getSpinnerFrame(Math.floor(nowMs / 100) % icons.spinner.length),
        color: theme.toolRunning,
      };
    case 'responding':
      return {
        label: `Responding ${formatAge(nowMs - activity.since.getTime())}`,
        icon: getSpinnerFrame(Math.floor(nowMs / 100) % icons.spinner.length),
        color: theme.info,
      };
    case 'aborted':
      return {
        label: 'Turn aborted',
        icon: icons.cross,
        color: theme.error,
      };
    case 'interrupted':
      // Backed by a confirmed error banner on the main pane; the freshness
      // suffix alongside says how long the turn has been silent.
      return {
        label: 'Turn likely interrupted',
        icon: icons.cross,
        color: theme.error,
      };
    case 'exited':
      // The pane is back at the user's shell; nothing will consume input.
      // Not an error — quitting is normal — but "Idle · waiting for you"
      // would be a lie, so say what happened and the one-word way back.
      return {
        label: 'Codex exited · run codex to restart',
        icon: icons.pending,
        color: colors.dim,
      };
    case 'idle':
      return {
        label: 'Idle · waiting for you',
        icon: icons.check,
        color: theme.success,
      };
  }
}

export function renderTurnActivityLine(
  activity: TurnActivity | undefined,
  width: number = Number.POSITIVE_INFINITY,
  nowMs: number = Date.now()
): string | null {
  if (!activity) {
    return null;
  }
  const presentation = turnPhasePresentation(activity, nowMs);
  const eventAgeMs = Math.max(
    0,
    nowMs - activity.lastActivityAt.getTime()
  );
  const freshness =
    eventAgeMs >= 5000
      ? colors.dim(` · event ${formatAge(eventAgeMs)} ago`)
      : '';
  // The last turn's wall time is parsed from every task_complete but never
  // reached the screen: it is the anchor for "how long does a turn here
  // usually take". Idle is where that question gets asked, and the cell is
  // the first to go when the row is too narrow.
  const lastTurn =
    activity.phase === 'idle' &&
    activity.lastTurnDurationMs !== undefined &&
    Number.isFinite(activity.lastTurnDurationMs) &&
    activity.lastTurnDurationMs >= 0
      ? colors.dim(
          ` · last turn ${formatToolDuration(activity.lastTurnDurationMs)}`
        )
      : '';
  const base = presentation.color(
    `${presentation.icon} ${presentation.label}`
  );
  let line = base + lastTurn + freshness;
  if (lastTurn && Number.isFinite(width) && visualLength(line) > width) {
    line = base + freshness;
  }
  return truncateAnsi(line, width);
}

function formatRateWindow(windowMinutes: number | undefined): string {
  if (!windowMinutes || windowMinutes <= 0) {
    return 'limit';
  }
  if (windowMinutes % 1440 === 0) {
    return `${windowMinutes / 1440}d`;
  }
  if (windowMinutes % 60 === 0) {
    return `${windowMinutes / 60}h`;
  }
  return `${windowMinutes}m`;
}

/**
 * Under a day out, the question is "how long until I can work again", not
 * "what time is it then" — measured live at 100% used with the reset that
 * same morning, the absolute form left the subtraction to the user. Beyond a
 * day the absolute moment reads better for planning, so it stays.
 */
const RESET_RELATIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

function formatResetTime(
  epochSeconds: number | undefined,
  windowMinutes: number | undefined,
  nowMs: number
): string | null {
  if (!epochSeconds || !Number.isFinite(epochSeconds)) {
    return null;
  }
  const date = new Date(epochSeconds * 1000);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  const untilMs = date.getTime() - nowMs;
  if (untilMs > 0 && untilMs < RESET_RELATIVE_WINDOW_MS) {
    return `in ${formatCompoundDuration(untilMs)}`;
  }
  return windowMinutes && windowMinutes >= 1440
    ? date.toLocaleString([], {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
}

/**
 * A quota window whose reset moment has already passed says nothing about the
 * current period. Rate limits are account-level state that only lands in the
 * HUD through the bound rollout's last `token_count` event, so a resumed or
 * idle session keeps replaying whatever snapshot it was left with — observed
 * live as "7d limit 84% | resets 08/05" a full week after that reset.
 */
function isExpiredWindow(window: RateLimitWindow, nowMs: number): boolean {
  const resetsAt = window.resets_at;
  return (
    resetsAt !== undefined &&
    Number.isFinite(resetsAt) &&
    resetsAt * 1000 <= nowMs
  );
}

/** Below this the quota is not a warning; it is still a number worth having. */
const RATE_LIMIT_PRESSURE_PERCENT = 70;

/**
 * Whether a snapshot is in an alert state: the account hit a limit, or the
 * degenerate post-exhaustion shape (no windows at all, a zeroed credit pool).
 * One predicate shared by the quota row and the notify hook, so "what counts
 * as hitting the wall" cannot drift between the pane and the notification.
 * An expired snapshot alerts on nothing — it describes a finished window.
 */
export function rateLimitAlertKind(
  limits: HudData['rateLimits'],
  nowMs: number
): 'reached' | 'credits-exhausted' | null {
  if (!limits) {
    return null;
  }
  const knownWindows = [limits.primary, limits.secondary].filter(
    (window): window is RateLimitWindow => Boolean(window)
  );
  const datedWindows = knownWindows.filter(
    (window) =>
      window.resets_at !== undefined && Number.isFinite(window.resets_at)
  );
  if (
    datedWindows.length > 0 &&
    datedWindows.every((window) => isExpiredWindow(window, nowMs))
  ) {
    return null;
  }
  if (
    Boolean(limits.rate_limit_reached_type) ||
    limits.spend_control_reached === true
  ) {
    return 'reached';
  }
  const liveWindows = knownWindows.filter(
    (window) =>
      window.used_percent !== undefined && !isExpiredWindow(window, nowMs)
  );
  const credits = limits.credits;
  if (
    liveWindows.length === 0 &&
    credits?.has_credits === false &&
    credits.unlimited !== true
  ) {
    return 'credits-exhausted';
  }
  return null;
}

/**
 * Below this the projection stays quiet: early in a window the slope is a
 * guess about a distant problem, and a standing forecast next to a small
 * number reads as noise. From half-spent onward it is the difference between
 * pacing and hitting the wall — measured on this account, ~24%/day exhausted
 * the window four days before its reset, both times with no warning.
 */
const PROJECTION_MIN_PERCENT = 50;

/** Same threshold as the reset countdown: under a day, say how long. */
function formatExhaustionEta(exhaustsAtMs: number, nowMs: number): string {
  const untilMs = exhaustsAtMs - nowMs;
  if (untilMs < RESET_RELATIVE_WINDOW_MS) {
    return `in ${formatCompoundDuration(untilMs)}`;
  }
  return `~${new Date(exhaustsAtMs).toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
  })}`;
}

export function renderRateLimitLine(
  data: HudData,
  width: number = Number.POSITIVE_INFINITY,
  nowMs: number = Date.now(),
  options: { includeBelowPressure?: boolean } = {}
): string | null {
  const limits = data.rateLimits;
  const knownWindows = [limits?.primary, limits?.secondary].filter(
    (window): window is RateLimitWindow => Boolean(window)
  );
  // "Reached" is part of the same snapshot, so it expires with it.
  const datedWindows = knownWindows.filter(
    (window) => window.resets_at !== undefined && Number.isFinite(window.resets_at)
  );
  const snapshotExpired =
    datedWindows.length > 0 &&
    datedWindows.every((window) => isExpiredWindow(window, nowMs));
  if (snapshotExpired) {
    return null;
  }

  // Last-resort signal for the degenerate snapshot codex writes once the
  // weekly window is spent: no windows, no reached flag, a zeroed credit
  // pool. Gated (inside the shared predicate) on the snapshot carrying no
  // window at all — a plan without credits would otherwise show a standing
  // false alarm beside a healthy weekly gauge.
  const alertKind = rateLimitAlertKind(limits, nowMs);
  const reached = alertKind === 'reached';
  const creditsExhausted = alertKind === 'credits-exhausted';
  const liveWindows = knownWindows.filter(
    (window) =>
      window.used_percent !== undefined && !isExpiredWindow(window, nowMs)
  );
  // A gauge that only lights up once the tank is nearly empty is not a gauge.
  // Measured on this account: the weekly window went 1% -> 48% in two days
  // while the row stayed hidden, and the previous window was last seen at 88%.
  // The caller decides whether there is a row to spare for the calm reading;
  // pressure and "reached" still render unconditionally.
  const shownWindows = options.includeBelowPressure
    ? liveWindows
    : liveWindows.filter(
        (window) =>
          (window.used_percent ?? 0) >= RATE_LIMIT_PRESSURE_PERCENT
      );
  if (
    !limits ||
    (!reached && shownWindows.length === 0 && !creditsExhausted)
  ) {
    return null;
  }

  const parts: string[] = [];
  for (const window of shownWindows) {
    const usedPercent = window.used_percent ?? 0;
    const color =
      usedPercent >= 90
        ? theme.error
        : usedPercent >= RATE_LIMIT_PRESSURE_PERCENT
          ? theme.warning
          : colors.dim;
    parts.push(
      color(
        `${formatRateWindow(window.window_minutes)} limit ${Math.round(usedPercent)}%`
      )
    );
    const reset = formatResetTime(
      window.resets_at,
      window.window_minutes,
      nowMs
    );
    if (reset) {
      parts.push(colors.dim(`resets ${reset}`));
    }
  }
  if (reached) {
    parts.push(theme.error('limit reached'));
  }
  if (creditsExhausted) {
    parts.push(theme.error('credits: 0'));
  }
  // The projected exhaustion, stated only while it precedes the reset — the
  // only case where the pace changes what the user should do — and placed
  // last so a narrow pane truncates the forecast before the facts.
  const projection = data.quotaProjection;
  const primary = limits?.primary;
  if (
    projection &&
    primary != null &&
    shownWindows.includes(primary) &&
    (primary.used_percent ?? 0) >= PROJECTION_MIN_PERCENT &&
    primary.resets_at !== undefined &&
    Number.isFinite(primary.resets_at) &&
    projection.exhaustsAtMs < primary.resets_at * 1000 &&
    projection.exhaustsAtMs > nowMs
  ) {
    parts.push(
      colors.dim(
        `${icons.arrow} empty ${formatExhaustionEta(projection.exhaustsAtMs, nowMs)}`
      )
    );
  }
  return truncateAnsi(parts.join(` ${colors.dim(icons.pipe)} `), width);
}

/**
 * Collector keys are internal names; the health row is the one place a user
 * reads them, so each gets a phrase that says what stopped working. "git
 * stale" and "protocol unknown 17" both prompted "what does that mean?".
 */
function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

const COLLECTOR_LABELS: Record<string, string> = {
  git: 'git status',
  rollout: 'session log',
  agents: 'agent tracking',
  session: 'session binding',
  environment: 'project scan',
  config: 'Codex config',
  overview: 'session overview',
  renderer: 'HUD display',
};

export function renderHealthLine(
  data: HudData,
  width: number = Number.POSITIVE_INFINITY,
  nowMs: number = Date.now()
): string | null {
  const warnings: string[] = [];
  for (const [name, health] of Object.entries(
    data.collectorHealth ?? {}
  )) {
    if (!health) {
      continue;
    }
    const label = COLLECTOR_LABELS[name] ?? name;
    if (health.status === 'error') {
      warnings.push(`${label} unavailable`);
    } else if (health.status === 'stale') {
      // A stale collector has succeeded before, so it always carries a
      // timestamp; `pending` covers the never-succeeded case and stays silent.
      const age = health.lastSuccessAt
        ? `${formatAge(nowMs - health.lastSuccessAt.getTime())} old`
        : 'not refreshing';
      warnings.push(`${label} ${age}`);
    }
  }

  const protocolHealth = data.protocolHealth;
  if (protocolHealth) {
    const unknownCount = [
      protocolHealth.unknownTopLevelTypes,
      protocolHealth.unknownResponseTypes,
      protocolHealth.unknownEventTypes,
    ].reduce(
      (total, counters) =>
        total +
        Object.values(counters).reduce(
          (subtotal, count) => subtotal + count,
          0
        ),
      0
    );
    if (unknownCount > 0) {
      warnings.push(
        `${unknownCount} unrecognized Codex ${plural(unknownCount, 'record')}`
      );
    }
    if (protocolHealth.malformedLines > 0) {
      const count = protocolHealth.malformedLines;
      warnings.push(
        `${count} unreadable session-log ${plural(count, 'line')}`
      );
    }
  }

  if (warnings.length === 0) {
    return null;
  }
  const warningIcon =
    process.env.CODEX_HUD_ASCII === '1' ? '!' : '⚠';
  return truncateAnsi(
    theme.warning(`${warningIcon} ${warnings.join(' · ')}`),
    width
  );
}

function formatToolWorkdir(workdir: string): string {
  const normalized = workdir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) {
    return '/';
  }
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
}

function presentationStatus(call: ToolCall): ToolGroupStatus {
  if (call.status === 'error') {
    return 'error';
  }
  if (call.result?.kind === 'yielded') {
    return 'yielded';
  }
  return 'completed';
}

/**
 * Safe display detail for an execution tool in `targets` mode.
 * write_stdin targets are collector-synthesized labels without command
 * content, so they pass through unchanged.
 */
function executionDisplayHead(call: ToolCall): string | undefined {
  if (!call.target) {
    return undefined;
  }
  if (call.name.toLowerCase() === 'write_stdin') {
    return sanitizeTerminalText(call.target);
  }
  const head = extractCommandHead(call.target);
  return head ? sanitizeTerminalText(head) : undefined;
}

function toolCallHasDetail(call: ToolCall): boolean {
  return Boolean(
    call.summary ??
    call.target ??
    call.workdir ??
    call.result ??
    call.duration
  );
}

function renderToolCallDetail(
  call: ToolCall,
  maxWidth: number,
  nowMs: number,
  paused: boolean = false
): string {
  const status = call.status === 'running' ? 'running' : presentationStatus(call);
  const icon = status === 'running'
    ? paused
      ? icons.pause
      : getSpinnerFrame(Math.floor(nowMs / 100) % icons.spinner.length)
    : status === 'error'
      ? icons.cross
      : status === 'yielded'
        ? icons.refresh
        : icons.check;
  const colorFn = status === 'running' || status === 'yielded'
    ? theme.toolRunning
    : status === 'error'
      ? theme.error
      : theme.success;

  const prefix = `${icon} ${call.name}`;
  const detailsMode = toolDetailsMode();
  const executionTool = isExecutionTool(call.name);
  // In `targets` mode execution tools show only a command head (`npm test`,
  // `sed && rg`); the full summary stays exclusive to `full` mode. The head
  // is re-derived here as defense in depth: even if a raw command ends up in
  // `target`, only program names and known subcommands reach the screen.
  const detail =
    detailsMode === 'full'
      ? call.summary ?? call.target
      : executionTool
        ? executionDisplayHead(call)
        : call.target ?? call.summary;
  const workdir = call.workdir ? `@${formatToolWorkdir(call.workdir)}` : undefined;
  const durationMs = call.status === 'running'
    ? Math.max(0, nowMs - call.timestamp.getTime())
    : call.result?.wallTimeMs ?? call.duration;
  const duration =
    durationMs !== undefined && Number.isFinite(durationMs)
      ? formatToolDuration(durationMs)
      : undefined;
  const result = call.result?.kind === 'exited' && call.result.exitCode !== undefined
    ? `exit ${call.result.exitCode}`
    : call.result?.kind === 'yielded' && call.result.sessionId
      ? `session ${call.result.sessionId}`
      : undefined;

  let suffixParts = [workdir, duration, result].filter(
    (part): part is string => Boolean(part)
  );
  const buildPlain = (summary: string | undefined): string => {
    const summaryPart = summary ? `: ${summary}` : '';
    const suffix = suffixParts.length > 0 ? ` ${suffixParts.join(' ')}` : '';
    return `${prefix}${summaryPart}${suffix}`;
  };

  if (!Number.isFinite(maxWidth)) {
    return colorFn(buildPlain(detail));
  }

  let plain = buildPlain(detail);
  if (visualLength(plain) <= maxWidth) {
    return colorFn(plain);
  }

  // Working directory is useful context but lower priority than status,
  // duration, and exit/session information.
  if (workdir) {
    suffixParts = suffixParts.filter((part) => part !== workdir);
    plain = buildPlain(detail);
    if (visualLength(plain) <= maxWidth) {
      return colorFn(plain);
    }
  }

  if (detail) {
    const fixedWidth = visualLength(buildPlain(undefined));
    const availableForDetail = Math.max(0, maxWidth - fixedWidth - 2);
    // Paths keep their tail (the file name); other details keep their head.
    const shortened = availableForDetail >= 4
      ? isPathDetailTool(call.name)
        ? truncateStart(detail, availableForDetail)
        : truncate(detail, availableForDetail)
      : undefined;
    plain = buildPlain(shortened);
  }

  return truncateAnsi(colorFn(plain), maxWidth);
}

/**
 * Group consecutive calls by tool name and count them
 * Returns array of { name, count, status }
 */
function groupToolCalls(calls: ToolCall[]): ToolCallGroup[] {
  const groups: ToolCallGroup[] = [];
  
  // Completed wait calls are low-signal orchestration noise; running waits
  // remain visible. update_plan already surfaces through the plan line.
  const finishedCalls = calls.filter(
    c =>
      (c.status === 'completed' || c.status === 'error') &&
      !(c.status === 'completed' && c.name.toLowerCase() === 'wait') &&
      c.name.toLowerCase() !== 'update_plan'
  );

  for (const call of finishedCalls) {
    const last = groups[groups.length - 1];
    const status = presentationStatus(call);
    const detail = isExecutionTool(call.name)
      ? executionDisplayHead(call)
      : undefined;

    if (last && last.name === call.name && last.status === status) {
      last.count++;
      last.detail = detail ?? last.detail;
    } else {
      groups.push({ name: call.name, count: 1, status, detail });
    }
  }

  return groups;
}

function renderToolGroup(group: ToolCallGroup): string {
  const icon = group.status === 'error'
    ? icons.cross
    : group.status === 'yielded'
      ? icons.refresh
      : icons.check;
  const colorFn = group.status === 'error'
    ? theme.error
    : group.status === 'yielded'
      ? theme.toolRunning
      : theme.success;
  const count = group.count > 1 ? ` ${icons.multiply}${group.count}` : '';
  const detail = group.detail ? ` (${truncate(group.detail, 24)})` : '';
  return colorFn(`${icon} ${group.name}${count}`) + (detail ? colors.dim(detail) : '');
}

function joinToolParts(
  parts: string[],
  totalPart: string | null,
  width: number
): string | null {
  if (parts.length === 0) {
    return null;
  }

  const separator = ` ${colors.dim(icons.pipe)} `;
  if (!Number.isFinite(width)) {
    return [...parts, ...(totalPart ? [totalPart] : [])].join(separator);
  }

  const selected: string[] = [];
  const separatorWidth = visualLength(separator);
  const totalWidth = totalPart ? visualLength(totalPart) : 0;
  const reservedForTotal = totalPart ? separatorWidth + totalWidth : 0;
  let usedWidth = 0;

  for (const part of parts) {
    const prefixWidth = selected.length > 0 ? separatorWidth : 0;
    const available = width - usedWidth - prefixWidth - reservedForTotal;
    if (available < 8) {
      break;
    }

    const fitted = visualLength(part) <= available
      ? part
      : truncateAnsi(part, available);
    selected.push(fitted);
    usedWidth += prefixWidth + visualLength(fitted);
    if (visualLength(part) > available) {
      break;
    }
  }

  if (selected.length === 0) {
    const available = Math.max(1, width - reservedForTotal);
    selected.push(truncateAnsi(parts[0], available));
  }
  if (totalPart) {
    selected.push(totalPart);
  }
  return truncateAnsi(selected.join(separator), width);
}

/**
 * Render the tools activity line
 * Format: ◐ exec_command: npm test @repo 1.4s | ✗ exec_command: rg … exit 1
 */
export function renderToolsLine(
  toolActivity: ToolActivity | undefined,
  width: number = Number.POSITIVE_INFINITY,
  nowMs: number = Date.now(),
  partialHistory: boolean = false,
  paused: boolean = false
): string | null {
  if (toolDetailsMode() === 'off') {
    return null;
  }
  if (!toolActivity || toolActivity.recentCalls.length === 0) {
    return null;
  }
  
  const parts: string[] = [];
  
  // Currently running tool (if any)
  const running = toolActivity.recentCalls.filter(c => c.status === 'running');
  const current = running.length > 0 ? running[running.length - 1] : undefined;
  const finishedCalls = toolActivity.recentCalls.filter(
    (call) =>
      call.status !== 'running' &&
      !(call.status === 'completed' && call.name.toLowerCase() === 'wait') &&
      call.name.toLowerCase() !== 'update_plan'
  );
  const reversedFinished = [...finishedCalls].reverse();
  const detailedFinished =
    reversedFinished.find(
      (call) => call.status === 'error' && toolCallHasDetail(call)
    ) ??
    reversedFinished.find((call) => toolCallHasDetail(call));
  // A failed call is more actionable than a running one, so its detail is
  // never dropped for width; successful details still yield to the running
  // tool on narrow panes.
  const showDetailedFinished = Boolean(
    detailedFinished &&
    (!current ||
      detailedFinished.status === 'error' ||
      !Number.isFinite(width) ||
      width >= 100)
  );
  const totalPart =
    toolActivity.totalCalls > toolActivity.recentCalls.length
      ? colors.dim(
          `(${partialHistory ? '≥' : ''}${toolActivity.totalCalls} total)`
        )
      : null;

  if (current && showDetailedFinished && detailedFinished) {
    const separatorWidth = 3;
    const totalReserve = totalPart
      ? visualLength(totalPart) + separatorWidth
      : 0;
    const detailArea = Number.isFinite(width)
      ? Math.max(40, width - totalReserve - separatorWidth)
      : Number.POSITIVE_INFINITY;
    const currentWidth = Number.isFinite(detailArea)
      ? Math.max(20, Math.floor(detailArea * 0.54))
      : Number.POSITIVE_INFINITY;
    const finishedWidth = Number.isFinite(detailArea)
      ? Math.max(20, detailArea - currentWidth)
      : Number.POSITIVE_INFINITY;
    parts.push(renderToolCallDetail(current, currentWidth, nowMs, paused));
    parts.push(renderToolCallDetail(detailedFinished, finishedWidth, nowMs));
  } else {
    if (current) {
      const totalReserve = totalPart ? visualLength(totalPart) + 3 : 0;
      const detailWidth = Number.isFinite(width)
        ? Math.max(20, Math.min(84, width - totalReserve))
        : Number.POSITIVE_INFINITY;
      parts.push(renderToolCallDetail(current, detailWidth, nowMs, paused));
    }
    if (showDetailedFinished && detailedFinished) {
      const totalReserve = totalPart ? visualLength(totalPart) + 3 : 0;
      const detailWidth = Number.isFinite(width)
        ? Math.max(20, Math.min(84, width - totalReserve))
        : Number.POSITIVE_INFINITY;
      parts.push(renderToolCallDetail(detailedFinished, detailWidth, nowMs));
    }
  }

  // Group the remaining completed calls so a detailed result does not also
  // appear in its aggregate count.
  const remainingCalls = showDetailedFinished && detailedFinished
    ? toolActivity.recentCalls.filter((call) => call.id !== detailedFinished.id)
    : toolActivity.recentCalls;
  const groups = groupToolCalls(remainingCalls);

  // Render grouped calls (limit to last 5 groups)
  const recentGroups = groups.slice(-5);
  for (const group of recentGroups) {
    parts.push(renderToolGroup(group));
  }
  
  return joinToolParts(parts, parts.length > 0 ? totalPart : null, width);
}

/**
 * Render the todos/plan progress line
 * Format: ≡ 3/7 steps | ✓ Task 1 | ◐ Task 2
 */
export function renderTodosLine(
  planProgress: PlanProgress | undefined,
  width: number = Number.POSITIVE_INFINITY
): string | null {
  if (!planProgress) {
    return null;
  }

  const parts: string[] = [];

  // Overall progress (if steps exist)
  if (planProgress.totalSteps > 0) {
    const { completedSteps, totalSteps } = planProgress;
    parts.push(theme.planProgress(`${icons.plan} ${completedSteps}/${totalSteps}`));
  }

  // Wide panes show more of each step instead of a fixed 30/20-char cut;
  // narrow panes fall back to the historical minimums.
  const currentStepCap = Number.isFinite(width)
    ? Math.max(30, Math.min(64, Math.floor(width * 0.4)))
    : 30;
  const completedStepCap = Number.isFinite(width)
    ? Math.max(20, Math.min(40, Math.floor(width * 0.2)))
    : 20;

  // Current step (if in progress)
  const inProgressSteps = planProgress.steps.filter(s => s.status === 'in_progress');
  if (inProgressSteps.length > 0) {
    const current = inProgressSteps[0];
    const spinner = getSpinnerFrame();
    const stepText = truncate(current.step, currentStepCap);
    parts.push(theme.planStepInProgress(`${spinner} ${stepText}`));
  }

  // Recent completed steps (last 2)
  const completedSteps = planProgress.steps.filter(s => s.status === 'completed').slice(-2);
  for (const step of completedSteps) {
    const stepText = truncate(step.step, completedStepCap);
    parts.push(theme.planStepCompleted(`${icons.check} ${stepText}`));
  }

  if (parts.length === 0) {
    return null;
  }

  return truncateAnsi(parts.join(` ${colors.dim(icons.pipe)} `), width);
}

/**
 * Collect all activity lines (tools + todos)
 */
function formatTokenCount(value: number): string {
  if (value >= 1000000) {
    return `${(value / 1000000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}K`;
  }
  return value.toString();
}

function formatSessionId(sessionId: string): string {
  if (sessionId.length <= 8) {
    return sessionId;
  }
  if (sessionId.length <= 12) {
    return sessionId.slice(0, 8);
  }
  return `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}`;
}

export function renderTokenLine(
  data: HudData,
  width: number = Number.POSITIVE_INFINITY
): string | null {
  const usage = data.tokenUsage?.last_token_usage ?? data.tokenUsage?.total_token_usage;
  // Always show token line if we have any token or context data
  if (!usage && !data.contextUsage) {
    return null;
  }

  const parts: string[] = [];
  const atLeast = data.partialHistory ? '≥' : '';
  // Everything but the context gauge, in the order it is given up when the row
  // does not fit. Trimming whole cells beats letting the outer truncation
  // slice through a parenthesised group mid-token.
  let tokensPart: string | null = null;
  let breakdownPart: string | null = null;
  let totalPart: string | null = null;
  let compactPart: string | null = null;

  // The gauge scales with the pane: a fixed twelve cells alone pushed this row
  // past a 45-column pane, where it is the row that matters most.
  const barWidth = Number.isFinite(width)
    ? Math.max(4, Math.min(12, Math.floor(width / 8)))
    : 12;

  // Context leads the row so the capacity signal survives narrow terminals.
  const ctx = data.contextUsage;
  if (ctx) {
    const bar = remainingBar(ctx.percent, barWidth);
    const remainingPercent = Math.max(0, 100 - ctx.percent);
    const remainingTokens = Math.max(0, ctx.total - ctx.used);
    const percentDisplay = ctx.percent >= 85
      ? theme.error(`${remainingPercent}% left`)
      : ctx.percent >= 70
        ? theme.warning(`${remainingPercent}% left`)
        : theme.success(`${remainingPercent}% left`);
    parts.unshift(
      `Ctx: ${bar} ${percentDisplay} (${formatTokenCount(remainingTokens)})`
    );
  } else if (data.tokenUsage?.model_context_window && usage) {
    const total = data.tokenUsage.model_context_window;
    const totalTokens = usage.total_tokens ?? 0;
    const percent = total > 0 ? Math.round((totalTokens / total) * 100) : 0;
    const remainingPercent = Math.max(0, 100 - percent);
    const remainingTokens = Math.max(0, total - totalTokens);
    const bar = remainingBar(percent, barWidth);
    const percentDisplay = percent >= 85
      ? theme.error(`${remainingPercent}% left`)
      : percent >= 70
        ? theme.warning(`${remainingPercent}% left`)
        : theme.success(`${remainingPercent}% left`);
    parts.unshift(
      `Ctx: ${bar} ${percentDisplay} (${formatTokenCount(remainingTokens)})`
    );
  }

  // Token counts section
  if (usage) {
    const cachedInput = usage.cached_input_tokens ?? 0;
    const nonCachedInput = Math.max(0, (usage.input_tokens ?? 0) - cachedInput);

    tokensPart = theme.tokenCount(
      `Tokens: ${formatTokenCount(usage.total_tokens ?? 0)}`
    );
    parts.push(tokensPart);

    const breakdown: string[] = [];
    if (nonCachedInput > 0) {
      breakdown.push(`in: ${formatTokenCount(nonCachedInput)}`);
    }
    if (cachedInput > 0) {
      breakdown.push(`cache: ${formatTokenCount(cachedInput)}`);
    }
    if (usage.output_tokens && usage.output_tokens > 0) {
      breakdown.push(`out: ${formatTokenCount(usage.output_tokens)}`);
    }

    if (breakdown.length > 0) {
      breakdownPart = colors.dim(`(${breakdown.join(', ')})`);
      parts.push(breakdownPart);
    }
  }

  // Cumulative spend across the whole session. It is already parsed from every
  // token_count event but never reached the screen, so the row could show
  // "7d limit 84%" with no way to see what had been burned to get there.
  const sessionTotal = data.tokenUsage?.total_token_usage?.total_tokens;
  if (
    data.tokenUsage?.last_token_usage &&
    sessionTotal !== undefined &&
    sessionTotal > (usage?.total_tokens ?? 0)
  ) {
    totalPart =
      colors.dim('Total: ') +
      theme.tokenCount(`${atLeast}${formatTokenCount(sessionTotal)}`);
    parts.push(totalPart);
  }

  if (ctx?.compactCount && ctx.compactCount > 0) {
    compactPart = colors.dim(`${icons.refresh}${atLeast}${ctx.compactCount}`);
    parts.push(compactPart);
  }

  if (parts.length === 0) {
    return null;
  }

  // Dim pipes match every other row's separator style.
  const tokenSeparator = ` ${colors.dim(icons.pipe)} `;
  let line = parts.join(tokenSeparator);
  if (Number.isFinite(width) && visualLength(line) > width) {
    // Least informative first. The context gauge is never a candidate: it is
    // why this row leads the layout.
    const dropOrder = [compactPart, totalPart, breakdownPart, tokensPart];
    const dropped = new Set<string>();
    for (const candidate of dropOrder) {
      if (visualLength(line) <= width) {
        break;
      }
      if (candidate === null) {
        continue;
      }
      dropped.add(candidate);
      line = parts.filter((part) => !dropped.has(part)).join(tokenSeparator);
    }
  }
  // Below roughly 28 columns even the lone context cell overflows; clamp here
  // so this renderer honours its width contract like every other row.
  return truncateAnsi(line, width);
}

export function renderSessionDetailLine(
  data: HudData,
  width: number = Number.POSITIVE_INFINITY
): string | null {
  // The session id is the only value on this row the user can act on:
  // `codex resume|fork|archive|delete|unarchive` all take the UUID. Abbreviated
  // to `019ff4e2…2ecc` it could be read but neither typed nor copied, so the
  // full id is shown whenever the row has room and the short form is kept only
  // as the narrow-pane fallback.
  const full = buildSessionDetailParts(data, width, false);
  if (full !== null) {
    return full;
  }
  return buildSessionDetailParts(data, width, true);
}

function buildSessionDetailParts(
  data: HudData,
  width: number,
  abbreviateSessionId: boolean
): string | null {
  const optionalParts: string[] = [];

  // Always show session info if we have a session
  const session = data.session;

  // Show working directory
  const cwd = sanitizeTerminalText(
    session?.cwd || data.project.cwd
  );
  if (cwd) {
    const home = process.env.HOME || '';
    let displayPath = cwd;
    if (home && cwd.startsWith(home)) {
      displayPath = '~' + cwd.slice(home.length);
    }
    if (Number.isFinite(width)) {
      const pathWidth = Math.max(1, width - visualLength('Dir: '));
      displayPath = truncateStart(displayPath, pathWidth);
    }
    const directoryPart =
      colors.dim('Dir: ') + osc8Link(theme.value(displayPath), fileUrl(cwd));
    if (
      Number.isFinite(width) &&
      visualLength(directoryPart) >= width
    ) {
      return truncateAnsi(directoryPart, width);
    }
    optionalParts.push(directoryPart);
  }

  // Show session ID if available
  let sessionPart: string | undefined;
  if (session?.id) {
    const id = sanitizeTerminalText(session.id);
    sessionPart =
      colors.dim('Session: ') +
      theme.info(abbreviateSessionId ? formatSessionId(id) : id);
    optionalParts.push(sessionPart);
  }


  // Show CLI version if available
  if (session?.cliVersion) {
    optionalParts.push(
      colors.dim('CLI: ') +
      theme.value(sanitizeTerminalText(session.cliVersion))
    );
  }
  
  // Show model provider if available
  if (session?.modelProvider) {
    optionalParts.push(
      colors.dim('Provider: ') +
      theme.value(sanitizeTerminalText(session.modelProvider))
    );
  }

  if (optionalParts.length === 0) {
    return null;
  }

  const separator = ` ${colors.dim(icons.pipe)} `;
  if (!Number.isFinite(width)) {
    return optionalParts.join(separator);
  }

  const selected: string[] = [];
  for (const part of optionalParts) {
    const candidate = [...selected, part].join(separator);
    if (visualLength(candidate) > width) {
      break;
    }
    selected.push(part);
  }
  if (
    !abbreviateSessionId &&
    sessionPart !== undefined &&
    !selected.includes(sessionPart)
  ) {
    // The full id did not fit. Rather than spend the row on the static cells
    // that outlived it, let the caller retry with the abbreviated form.
    return null;
  }
  return truncateAnsi(
    (selected.length > 0 ? selected : [optionalParts[0] ?? '']).join(separator),
    width
  );
}
