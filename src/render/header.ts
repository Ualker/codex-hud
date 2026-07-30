/**
 * Header line renderer
 * Phase 3: Redesigned to match claude-hud layout
 * 
 * Layout:
 * Row 1: [Model] | project-name git:(branch *) | ⏱️ 10m
 * Row 2: [FULL ACCESS] | Approval | Sandbox | Fast | inventory
 * Row 3: collector/protocol health warnings when needed
 * Row 4: context remaining, token counts and rate-limit pressure
 * Row 5+: live turn/tool/agent activity, session diagnostics, then plan/history
 */

import type {
  AgentActivity,
  HudData,
  RenderOptions,
  LayoutConfig,
  SessionOverviewItem,
} from '../types.js';
import { DEFAULT_LAYOUT } from '../types.js';
import {
  colors,
  theme,
  icons,
  coloredBar,
  sanitizeTerminalText,
  truncate,
  truncateAnsi,
  visualLength,
} from './colors.js';
import {
  renderIdentityLine,
  renderProjectLine,
  renderEnvironmentLine,
  renderUsageLine,
  renderTokenLine,
  renderSessionDetailLine,
  renderToolsLine,
  renderTodosLine,
  renderAgentLines,
  renderTurnActivityLine,
  renderRateLimitLine,
  renderHealthLine,
} from './lines/index.js';

export function renderCompactAgentSummary(agentActivity: AgentActivity | undefined): string | null {
  if (!agentActivity) {
    return null;
  }
  if (agentActivity.rootTrackingError) {
    return theme.error('Agents: tracking error');
  }
  if (agentActivity.visibleAgentCount > 0) {
    return theme.agentType(`Agents: ${agentActivity.visibleAgentCount}`);
  }
  return null;
}

/**
 * Render the compact layout (single line)
 * Format: [Model] █████ 45% | project git:(branch *) | 2 MCPs | ⏱️ 10m
 */
function renderCompactLayout(data: HudData, layout: LayoutConfig, width: number): string[] {
  const parts: string[] = [];
  
  // Identity (model + context bar)
  parts.push(renderIdentityLine(data, layout, { maxWidth: width }));
  
  // Project + git
  parts.push(renderProjectLine(data));

  const agentSummary = renderCompactAgentSummary(data.agentActivity);
  if (agentSummary) {
    parts.push(agentSummary);
  }
  
  // Quick stats (just MCP count)
  const mcpCount = data.project.mcpCount;
  if (mcpCount > 0) {
    parts.push(theme.info(`${mcpCount}`) + colors.dim(' MCPs'));
  }
  
  // Duration
  const usageLine = renderUsageLine(data, layout);
  if (usageLine) {
    parts.push(usageLine);
  }
  
  const separator = layout.showSeparators ? theme.separator(' │ ') : ' ';
  let row = parts.join(separator);
  if (visualLength(row) <= width) {
    return [row];
  }

  if (agentSummary) {
    const identity = parts[0] ?? '';
    const project = parts[1] ?? '';

    const withoutMcp = [identity, project, agentSummary];
    if (usageLine) {
      withoutMcp.push(usageLine);
    }
    row = withoutMcp.join(separator);
    if (visualLength(row) <= width) {
      return [row];
    }

    const withoutDuration = [identity, project, agentSummary];
    row = withoutDuration.join(separator);
    if (visualLength(row) <= width) {
      return [row];
    }

    const reservedWidth = visualLength(identity)
      + visualLength(agentSummary)
      + (2 * visualLength(separator));
    const availableForProject = width - reservedWidth;
    if (availableForProject > 0) {
      const shortenedProject = renderProjectLine(data, {
        includeFileStats: false,
        maxWidth: availableForProject,
      });
      row = [identity, shortenedProject, agentSummary].join(separator);
      if (visualLength(row) <= width) {
        return [row];
      }
    }

    row = [identity, agentSummary].join(separator);
    if (visualLength(row) <= width) {
      return [row];
    }

    const availableForIdentity = width - visualLength(agentSummary) - visualLength(separator);
    if (availableForIdentity > 0) {
      const shortenedIdentity = renderIdentityLine(data, layout, { maxWidth: availableForIdentity });
      row = [shortenedIdentity, agentSummary].join(separator);
      if (visualLength(row) <= width) {
        return [row];
      }
    }

    if (visualLength(agentSummary) <= width) {
      return [agentSummary];
    }
    return [truncateAnsi(agentSummary, width)];
  }

  const trimmedParts = parts.slice(0, 2);
  row = trimmedParts.join(separator);
  if (visualLength(row) <= width) {
    return [row];
  }

  const identity = parts[0] ?? '';
  const availableForProject = Math.max(0, width - visualLength(identity) - visualLength(separator));
  const project = renderProjectLine(data, { includeFileStats: false, maxWidth: availableForProject });
  return [identity + separator + project];
}

/**
 * Render the expanded layout (multiple lines)
 * Row 1: [Model] █████░░░░░ 45% | project-name git:(branch *) | ⏱️ 10m
 * Row 2: 2 AGENTS.md | 3 extensions | 3 skills | 2 hooks | Approval: ask for approval | Fast: on
 * Row 3: Ctx: ████░░░░ 45% (50K/128K) | Tokens: 12.5K
 * Row 4+: Current activity and agents, then Dir/Session, plan, and tool history
 */
function renderExpandedLayout(data: HudData, layout: LayoutConfig, width: number): string[] {
  const lines: string[] = [];
  
  // Row 1: Identity | Project | Duration
  const row1Parts: string[] = [];
  const identityLine = renderIdentityLine(data, layout, { maxWidth: width, showContext: false });
  row1Parts.push(identityLine);
  row1Parts.push(renderProjectLine(data));
  
  const usageLine = renderUsageLine(data, layout);
  if (usageLine) {
    row1Parts.push(usageLine);
  }
  
  const separator = layout.showSeparators ? theme.separator(' │ ') : ' ';
  let row1 = row1Parts.join(separator);
  if (usageLine && visualLength(row1) > width) {
    row1 = row1Parts.slice(0, 2).join(separator);
  }
  if (visualLength(row1) > width) {
    const availableForProject = Math.max(0, width - visualLength(identityLine) - visualLength(separator));
    const projectLine = renderProjectLine(data, { includeFileStats: false, maxWidth: availableForProject });
    row1 = [identityLine, projectLine].join(separator);
  }
  lines.push(row1);
  
  // Row 2: Environment line
  const envLine = renderEnvironmentLine(data, width);
  if (envLine) {
    lines.push(envLine);
  }

  // Collector/protocol warnings outrank ordinary usage details.
  const healthLine = renderHealthLine(data, width);
  if (healthLine) {
    lines.push(healthLine);
  }

  // Context capacity is actionable and remains ahead of activity history.
  const tokenLine = renderTokenLine(data);
  const rateLimitLine = renderRateLimitLine(data, width);
  if (tokenLine) {
    const combined = rateLimitLine
      ? `${tokenLine} ${colors.dim('│')} ${rateLimitLine}`
      : tokenLine;
    if (visualLength(combined) <= width) {
      lines.push(combined);
    } else {
      lines.push(tokenLine);
      if (rateLimitLine) {
        lines.push(rateLimitLine);
      }
    }
  } else if (rateLimitLine) {
    lines.push(rateLimitLine);
  }

  const toolsLine = renderToolsLine(data.toolActivity, width);
  const hasRunningTool = Boolean(
    data.toolActivity?.recentCalls.some(
      (call) => call.status === 'running'
    )
  );
  const turnLine = renderTurnActivityLine(data.turnActivity, width);
  const agentLines = renderAgentLines(data.agentActivity, width);
  const planLine = renderTodosLine(data.planProgress);

  if (hasRunningTool && toolsLine) {
    lines.push(toolsLine);
  } else if (turnLine) {
    lines.push(turnLine);
  }

  lines.push(...agentLines);
  // Keep project identity visible before plan and completed-tool history. Live
  // turn/tool/agent state still outranks it.
  const sessionLine = renderSessionDetailLine(data, width);
  if (sessionLine) {
    lines.push(sessionLine);
  }
  if (planLine) {
    lines.push(planLine);
  }
  if (!hasRunningTool && toolsLine) {
    lines.push(toolsLine);
  }
  
  return lines;
}

/**
 * Render the overview layout (active sessions only)
 * Each line: project | phase | Ctx ... % left | age | short session ID
 */
function renderOverviewLayout(
  data: HudData,
  layout: LayoutConfig,
  width: number
): string[] {
  const overview = data.overview;
  if (!overview || overview.sessions.length === 0) {
    return [colors.dim('No active sessions')];
  }

  const now = Date.now();
  const formatAge = (timestamp: Date | undefined): string => {
    if (!timestamp) {
      return '--';
    }
    const seconds = Math.max(
      0,
      Math.floor((now - timestamp.getTime()) / 1000)
    );
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h`;
  };
  const phaseLabel = (
    session: SessionOverviewItem
  ): string => {
    const phase = session.turnActivity?.phase;
    switch (phase) {
      case 'running-tool':
        return theme.toolRunning('Tool');
      case 'thinking':
        return theme.toolRunning('Thinking');
      case 'responding':
        return theme.info('Responding');
      case 'aborted':
        return theme.error('Aborted');
      case 'idle':
        return theme.success('Idle');
      default:
        return colors.dim('Unknown');
    }
  };

  return overview.sessions.map((session) => {
    const shortId = session.id.length > 8 ? session.id.slice(0, 8) : session.id;
    const ctx = session.contextUsage;
    const ctxDisplay = ctx
      ? `${coloredBar(ctx.percent, layout.barWidth)} ${100 - ctx.percent}% left`
      : colors.dim('ctx --');
    const project =
      sanitizeTerminalText(
        session.projectName ?? session.cwd ?? shortId
      ) || shortId;
    const parts = [
      theme.projectName(truncate(project, 24)),
      phaseLabel(session),
      ctxDisplay,
      colors.dim(`${formatAge(session.lastActivityAt)} ago`),
      colors.dim(shortId),
    ];
    return truncateAnsi(
      parts.join(` ${colors.dim('│')} `),
      width
    );
  });
}

/**
 * Render the full HUD output (all lines)
 */
export function renderHud(data: HudData, options: RenderOptions): string[] {
  const layout = options.layout ?? DEFAULT_LAYOUT;

  if (data.displayMode === 'overview') {
    return renderOverviewLayout(data, layout, options.width);
  }
  
  if (layout.mode === 'compact') {
    return renderCompactLayout(data, layout, options.width);
  }
  
  return renderExpandedLayout(data, layout, options.width);
}

// ============================================================================
// Legacy exports for backward compatibility
// ============================================================================

/**
 * Render the main header line (legacy)
 * @deprecated Use renderHud instead
 */
export function renderHeader(data: HudData, options: RenderOptions): string {
  const lines = renderHud(data, options);
  return lines[0] || '';
}

/**
 * Render the second line with detailed info (legacy)
 * @deprecated Use renderHud instead
 */
export function renderDetails(data: HudData, options: RenderOptions): string {
  const lines = renderHud(data, options);
  return lines[1] || '';
}

/**
 * Render the third line with tool activity (legacy)
 * @deprecated Use renderHud instead
 */
export function renderActivityLine(data: HudData, _options: RenderOptions): string | null {
  const lines = renderHud(data, _options);
  return lines[2] || null;
}
