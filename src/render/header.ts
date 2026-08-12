/**
 * Header line renderer
 * Phase 3: Redesigned to match claude-hud layout
 * 
 * Layout:
 * Row 1: [Model] | project-name git:(branch *) | up 10m
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
  remainingBar,
  padEnd,
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
  renderAgentSummaryLine,
  renderBindingHintLine,
  renderToolDetailsNotice,
} from './lines/index.js';
import { formatCompactAge } from '../utils/format-age.js';

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
function renderExpandedLayout(
  data: HudData,
  layout: LayoutConfig,
  width: number,
  maxLines: number = Number.POSITIVE_INFINITY
): string[] {
  const separator = layout.showSeparators ? theme.separator(' │ ') : ' ';

  // Row 1: Identity | Project | Duration
  const identityLine = renderIdentityLine(data, layout, { maxWidth: width, showContext: false });
  const buildRow1 = (suffix: string | null): string => {
    const parts: string[] = [identityLine, renderProjectLine(data)];
    const usageLine = renderUsageLine(data, layout);
    if (usageLine) {
      parts.push(usageLine);
    }
    if (suffix) {
      parts.push(suffix);
    }

    let row = parts.join(separator);
    if (usageLine && visualLength(row) > width) {
      row = [...parts.slice(0, 2), ...(suffix ? [suffix] : [])].join(separator);
    }
    if (visualLength(row) > width) {
      const reserved =
        visualLength(identityLine) +
        visualLength(separator) +
        (suffix ? visualLength(suffix) + visualLength(separator) : 0);
      const projectLine = renderProjectLine(data, {
        includeFileStats: false,
        maxWidth: Math.max(0, width - reserved),
      });
      row = [identityLine, projectLine, ...(suffix ? [suffix] : [])].join(separator);
    }
    return row;
  };

  const envLine = renderEnvironmentLine(data, width);
  // Collector/protocol warnings outrank ordinary usage details.
  const healthLine = renderHealthLine(data, width);

  // Context capacity is actionable and remains ahead of activity history.
  const tokenLine = renderTokenLine(data, width);
  const rateLimitLine = renderRateLimitLine(data, width);
  const usageRows: string[] = [];
  if (tokenLine) {
    const combined = rateLimitLine
      ? `${tokenLine} ${colors.dim(icons.pipe)} ${rateLimitLine}`
      : tokenLine;
    if (visualLength(combined) <= width) {
      usageRows.push(combined);
    } else {
      usageRows.push(tokenLine);
      if (rateLimitLine) {
        usageRows.push(rateLimitLine);
      }
    }
  } else if (rateLimitLine) {
    usageRows.push(rateLimitLine);
  }

  const toolsLine = renderToolsLine(
    data.toolActivity,
    width,
    Date.now(),
    data.partialHistory
  );
  const hasRunningTool = Boolean(
    data.toolActivity?.recentCalls.some(
      (call) => call.status === 'running'
    )
  );
  const turnLine = renderTurnActivityLine(data.turnActivity, width);
  const agentLines = renderAgentLines(data.agentActivity, width);
  const agentSummaryLine = renderAgentSummaryLine(data.agentActivity, width);
  const planLine = renderTodosLine(data.planProgress, width);
  const sessionLine = renderSessionDetailLine(data, width);
  // Nothing bound yet: say so instead of rendering three rows and letting the
  // blank remainder read as a broken HUD.
  const bindingHintLine = renderBindingHintLine(data, width);
  // Receipt for the `t` hotkey; it stands in for the tool row that the `off`
  // mode removes, which is the case with no other on-screen evidence.
  const toolDetailsNotice = toolsLine ? null : renderToolDetailsNotice(width);

  const fullAccess =
    (data.session?.sandboxMode ?? data.config.sandbox_mode) ===
    'danger-full-access';

  interface Compression {
    dropSession?: boolean;
    collapseAgents?: boolean;
    dropEnv?: boolean;
  }

  const assemble = (compression: Compression): string[] => {
    const lines: string[] = [];
    // The environment row is static for the whole session, so it is the first
    // whole category to go — but it is also where the sandbox badge lives, so
    // that badge moves up to row 1 rather than disappearing with it.
    const keepEnv = Boolean(envLine) && !compression.dropEnv;
    lines.push(
      buildRow1(
        !keepEnv && fullAccess ? theme.error('[FULL ACCESS]') : null
      )
    );
    if (keepEnv && envLine) {
      lines.push(envLine);
    }
    if (healthLine) {
      lines.push(healthLine);
    }
    lines.push(...usageRows);

    if (hasRunningTool && toolsLine) {
      lines.push(toolsLine);
    } else if (turnLine) {
      lines.push(turnLine);
    } else if (bindingHintLine) {
      lines.push(bindingHintLine);
    }

    if (compression.collapseAgents && agentSummaryLine) {
      lines.push(agentSummaryLine);
    } else {
      lines.push(...agentLines);
    }
    if (planLine) {
      lines.push(planLine);
    }
    if (!hasRunningTool && toolsLine) {
      lines.push(toolsLine);
    } else if (toolDetailsNotice) {
      lines.push(toolDetailsNotice);
    }
    // Static identity (Dir/Session/CLI) never changes mid-session; keep it
    // last so small panes hide it before live plan/tool state.
    if (sessionLine && !compression.dropSession) {
      lines.push(sessionLine);
    }

    return lines;
  };

  // Degrade by dropping whole low-signal rows rather than letting the viewport
  // clip the tail, which used to hide the plan row and even a running agent
  // while keeping a static config row that had not changed all session.
  const steps: Compression[] = [
    {},
    { dropSession: true },
    { dropSession: true, collapseAgents: true },
    { dropSession: true, collapseAgents: true, dropEnv: true },
  ];

  let rendered = assemble(steps[0]);
  if (!Number.isFinite(maxLines)) {
    return rendered;
  }
  for (const step of steps) {
    rendered = assemble(step);
    if (rendered.length <= maxLines) {
      break;
    }
  }
  return rendered;
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
  const formatAge = (timestamp: Date | undefined): string =>
    timestamp ? formatCompactAge(now - timestamp.getTime()) : '--';
  const phaseLabel = (
    session: SessionOverviewItem
  ): string => {
    // An open session that has never run a turn is not unknown; Codex simply
    // has not written a rollout for it yet.
    if (session.neverStarted) {
      return colors.dim('Ready');
    }
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

  // Pad the leading columns to shared widths so the overview scans as a table.
  const projectNames = overview.sessions.map((session) => {
    const shortId = session.id.length > 8 ? session.id.slice(0, 8) : session.id;
    const project =
      sanitizeTerminalText(
        session.projectName ?? session.cwd ?? shortId
      ) || shortId;
    return truncate(project, 24);
  });
  const projectColumnWidth = Math.max(
    ...projectNames.map((name) => visualLength(name))
  );
  const phaseLabels = overview.sessions.map((session) => phaseLabel(session));
  const phaseColumnWidth = Math.max(
    ...phaseLabels.map((label) => visualLength(label))
  );

  // Sessions without context data (never started, or a rollout that could not
  // be parsed) must still occupy the gauge column, or every column after them
  // shifts left and the table stops scanning as a table.
  const ctxDisplays = overview.sessions.map((session) => {
    const ctx = session.contextUsage;
    return ctx
      ? `${remainingBar(ctx.percent, layout.barWidth)} ${100 - ctx.percent}% left`
      : colors.dim('--');
  });
  const ctxColumnWidth = Math.max(
    ...ctxDisplays.map((display) => visualLength(display))
  );
  const ageDisplays = overview.sessions.map((session) =>
    colors.dim(
      session.lastActivityAt ? `${formatAge(session.lastActivityAt)} ago` : '--'
    )
  );
  const ageColumnWidth = Math.max(
    ...ageDisplays.map((display) => visualLength(display))
  );

  return overview.sessions.map((session, index) => {
    const shortId = session.id.length > 8 ? session.id.slice(0, 8) : session.id;
    const parts = [
      padEnd(theme.projectName(projectNames[index]), projectColumnWidth),
      padEnd(phaseLabels[index], phaseColumnWidth),
      padEnd(ctxDisplays[index], ctxColumnWidth),
      padEnd(ageDisplays[index], ageColumnWidth),
      colors.dim(shortId),
    ];
    // Mark the row this HUD is bound to; without it the only clue is the
    // 8-char session id.
    const marker =
      data.overviewSelfSessionId !== undefined &&
      session.id === data.overviewSelfSessionId
        ? theme.info(`${icons.bullet} `)
        : '  ';
    return truncateAnsi(
      marker + parts.join(` ${colors.dim('│')} `),
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

  return renderExpandedLayout(
    data,
    layout,
    options.width,
    options.maxLines ?? Number.POSITIVE_INFINITY
  );
}
