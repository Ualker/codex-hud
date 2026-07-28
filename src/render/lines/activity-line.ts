/**
 * Activity Line Renderer
 * Renders: ◐ Edit: file.ts | ✓ Read ×3
 * Shows current and recent tool/agent activity
 */

import {
  theme,
  colors,
  icons,
  getSpinnerFrame,
  truncate,
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
} from '../../types.js';

const DESCENDANT_PREFIX = '↳';

export function formatAgentElapsed(startedAt: Date, nowMs: number = Date.now()): string {
  const startedAtMs = startedAt.getTime();
  if (!Number.isFinite(startedAtMs)) {
    throw new Error('Agent elapsed startedAt must be a valid Date');
  }
  if (!Number.isFinite(nowMs)) {
    throw new Error('Agent elapsed nowMs must be finite');
  }
  if (nowMs < startedAtMs) {
    throw new Error('Agent elapsed nowMs cannot be before startedAt');
  }

  const elapsedSeconds = Math.floor((nowMs - startedAtMs) / 1000);
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
  if (row.status === 'tracking-error') {
    return renderAgentRow(icons.cross, row.label, ' tracking error', theme.error, width);
  }
  if (row.status !== 'starting' && row.status !== 'running') {
    throw new Error(`Unknown agent display status: ${String(row.status)}`);
  }
  if (!row.elapsedStartedAt) {
    throw new Error(`Agent ${row.threadId} ${row.status} row requires elapsedStartedAt`);
  }

  const spinnerIndex = Math.floor(nowMs / 100) % icons.spinner.length;
  const spinner = getSpinnerFrame(spinnerIndex);
  const elapsed = formatAgentElapsed(row.elapsedStartedAt, nowMs);
  const descendants = row.activeDescendantCount > 0
    ? ` ${DESCENDANT_PREFIX}${row.activeDescendantCount}`
    : '';
  return renderAgentRow(
    spinner,
    row.label,
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

type ToolGroupStatus = 'completed' | 'error' | 'yielded';

interface ToolCallGroup {
  name: string;
  count: number;
  status: ToolGroupStatus;
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
  nowMs: number
): string {
  const status = call.status === 'running' ? 'running' : presentationStatus(call);
  const icon = status === 'running'
    ? getSpinnerFrame(Math.floor(nowMs / 100) % icons.spinner.length)
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
  const detail = call.summary ?? call.target;
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
    const shortened = availableForDetail >= 4
      ? truncate(detail, availableForDetail)
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
  
  // Completed wait calls are low-signal orchestration noise; running waits remain visible.
  const finishedCalls = calls.filter(
    c =>
      (c.status === 'completed' || c.status === 'error') &&
      !(c.status === 'completed' && c.name.toLowerCase() === 'wait')
  );
  
  for (const call of finishedCalls) {
    const last = groups[groups.length - 1];
    const status = presentationStatus(call);
    
    if (last && last.name === call.name && last.status === status) {
      last.count++;
    } else {
      groups.push({ name: call.name, count: 1, status });
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
  return colorFn(`${icon} ${group.name}${count}`);
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
  nowMs: number = Date.now()
): string | null {
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
  const showDetailedFinished = Boolean(
    detailedFinished &&
    (!current || !Number.isFinite(width) || width >= 100)
  );
  const totalPart =
    toolActivity.totalCalls > toolActivity.recentCalls.length
      ? colors.dim(`(${toolActivity.totalCalls} total)`)
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
    parts.push(renderToolCallDetail(current, currentWidth, nowMs));
    parts.push(renderToolCallDetail(detailedFinished, finishedWidth, nowMs));
  } else {
    if (current) {
      const totalReserve = totalPart ? visualLength(totalPart) + 3 : 0;
      const detailWidth = Number.isFinite(width)
        ? Math.max(20, Math.min(84, width - totalReserve))
        : Number.POSITIVE_INFINITY;
      parts.push(renderToolCallDetail(current, detailWidth, nowMs));
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
 * Format: 📝 3/7 steps | ✓ Task 1 | ◐ Task 2
 */
export function renderTodosLine(planProgress: PlanProgress | undefined): string | null {
  if (!planProgress) {
    return null;
  }
  
  const parts: string[] = [];
  
  // Overall progress (if steps exist)
  if (planProgress.totalSteps > 0) {
    const { completedSteps, totalSteps } = planProgress;
    parts.push(theme.planProgress(`${icons.plan} ${completedSteps}/${totalSteps}`));
  }
  
  // Current step (if in progress)
  const inProgressSteps = planProgress.steps.filter(s => s.status === 'in_progress');
  if (inProgressSteps.length > 0) {
    const current = inProgressSteps[0];
    const spinner = getSpinnerFrame();
    const stepText = truncate(current.step, 30);
    parts.push(theme.planStepInProgress(`${spinner} ${stepText}`));
  }
  
  // Recent completed steps (last 2)
  const completedSteps = planProgress.steps.filter(s => s.status === 'completed').slice(-2);
  for (const step of completedSteps) {
    const stepText = truncate(step.step, 20);
    parts.push(theme.planStepCompleted(`${icons.check} ${stepText}`));
  }
  
  if (parts.length === 0) {
    return null;
  }
  
  return parts.join(` ${colors.dim(icons.pipe)} `);
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

/**
 * Render a colored progress bar for context usage
 */
function renderContextProgressBar(percent: number, width: number = 10): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  
  const filledChar = '█';
  const emptyChar = '░';
  
  let colorFn: (s: string) => string;
  if (clamped >= 85) {
    colorFn = theme.error;
  } else if (clamped >= 70) {
    colorFn = theme.warning;
  } else {
    colorFn = theme.success;
  }
  
  const filledStr = filledChar.repeat(filled);
  const emptyStr = emptyChar.repeat(empty);
  
  return colorFn(filledStr) + colors.dim(emptyStr);
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

export function renderTokenLine(data: HudData): string | null {
  const usage = data.tokenUsage?.last_token_usage ?? data.tokenUsage?.total_token_usage;
  // Always show token line if we have any token or context data
  if (!usage && !data.contextUsage) {
    return null;
  }

  const parts: string[] = [];

  // Context leads the row so the capacity signal survives narrow terminals.
  const ctx = data.contextUsage;
  if (ctx) {
    const bar = renderContextProgressBar(ctx.percent, 12);
    const percentDisplay = ctx.percent >= 85 
      ? theme.error(`${ctx.percent}%`)
      : ctx.percent >= 70 
        ? theme.warning(`${ctx.percent}%`) 
        : theme.success(`${ctx.percent}%`);
    parts.unshift(
      `Ctx: ${bar} ${percentDisplay} (${formatTokenCount(ctx.used)}/${formatTokenCount(ctx.total)})`
    );
  } else if (data.tokenUsage?.model_context_window && usage) {
    const total = data.tokenUsage.model_context_window;
    const totalTokens = usage.total_tokens ?? 0;
    const percent = total > 0 ? Math.round((totalTokens / total) * 100) : 0;
    const bar = renderContextProgressBar(percent, 12);
    const percentDisplay = percent >= 85 
      ? theme.error(`${percent}%`)
      : percent >= 70 
        ? theme.warning(`${percent}%`) 
        : theme.success(`${percent}%`);
    parts.unshift(
      `Ctx: ${bar} ${percentDisplay} (${formatTokenCount(totalTokens)}/${formatTokenCount(total)})`
    );
  }

  // Token counts section
  if (usage) {
    const cachedInput = usage.cached_input_tokens ?? 0;
    const nonCachedInput = Math.max(0, (usage.input_tokens ?? 0) - cachedInput);

    parts.push(theme.tokenCount(`Tokens: ${formatTokenCount(usage.total_tokens ?? 0)}`));

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
      parts.push(colors.dim(`(${breakdown.join(', ')})`));
    }
  }

  if (ctx?.compactCount && ctx.compactCount > 0) {
    parts.push(colors.dim(`${icons.refresh}${ctx.compactCount}`));
  }

  return parts.length > 0 ? parts.join(' | ') : null;
}

export function renderSessionDetailLine(data: HudData): string | null {
  const parts: string[] = [];
  
  // Always show session info if we have a session
  const session = data.session;
  
  // Show working directory
  const cwd = session?.cwd || data.project.cwd;
  if (cwd) {
    const home = process.env.HOME || '';
    let displayPath = cwd;
    if (home && cwd.startsWith(home)) {
      displayPath = '~' + cwd.slice(home.length);
    }
    if (displayPath.length > 50) {
      displayPath = '…' + displayPath.slice(-49);
    }
    parts.push(colors.dim('Dir: ') + theme.value(displayPath));
  }

  // Show session ID if available
  if (session?.id) {
    parts.push(colors.dim('Session: ') + theme.info(formatSessionId(session.id)));
  }
  
  // Show CLI version if available
  if (session?.cliVersion) {
    parts.push(colors.dim('CLI: ') + theme.value(session.cliVersion));
  }
  
  // Show model provider if available
  if (session?.modelProvider) {
    parts.push(colors.dim('Provider: ') + theme.value(session.modelProvider));
  }

  return parts.length > 0 ? parts.join(` ${colors.dim(icons.pipe)} `) : null;
}

export function collectActivityLines(data: HudData, width?: number): string[] {
  const lines: string[] = [];

  const tokenLine = renderTokenLine(data);
  if (tokenLine) {
    lines.push(tokenLine);
  }

  const sessionLine = renderSessionDetailLine(data);
  if (sessionLine) {
    lines.push(sessionLine);
  }

  // Tools line
  const toolsLine = renderToolsLine(
    data.toolActivity,
    width ?? Number.POSITIVE_INFINITY
  );
  if (toolsLine) {
    lines.push(toolsLine);
  }

  lines.push(...renderAgentLines(data.agentActivity, width ?? Number.MAX_SAFE_INTEGER));
  
  // Todos/plan line
  const todosLine = renderTodosLine(data.planProgress);
  if (todosLine) {
    lines.push(todosLine);
  }
  
  return lines;
}
