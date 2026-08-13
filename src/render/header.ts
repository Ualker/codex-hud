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
  truncateStart,
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
  // Two readings of the same account quota: the alert form only appears under
  // pressure, the calm form always states where the window stands. The calm
  // one is worth a row only when there is one to spare, so the ladder picks.
  const rateLimitAlertLine = renderRateLimitLine(data, width);
  const rateLimitCalmLine = renderRateLimitLine(data, width, Date.now(), {
    includeBelowPressure: true,
  });
  const buildUsageRows = (rateLimitLine: string | null): string[] => {
    const rows: string[] = [];
    if (tokenLine) {
      const combined = rateLimitLine
        ? `${tokenLine} ${colors.dim(icons.pipe)} ${rateLimitLine}`
        : tokenLine;
      if (visualLength(combined) <= width) {
        rows.push(combined);
      } else {
        rows.push(tokenLine);
        if (rateLimitLine) {
          rows.push(rateLimitLine);
        }
      }
    } else if (rateLimitLine) {
      rows.push(rateLimitLine);
    }
    return rows;
  };

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

  const runtimeSandbox = data.session?.sandboxMode;
  const accessUnknown =
    data.partialHistory === true && runtimeSandbox === undefined;
  const fullAccess =
    runtimeSandbox === 'danger-full-access' ||
    (!data.partialHistory &&
      runtimeSandbox === undefined &&
      data.config.sandbox_mode === 'danger-full-access');

  /**
   * One rung of the layout ladder, from most to least informative. The ladder
   * used to only ever remove rows; `keepTurnWithTool` is the first rung that
   * adds one, because the running-tool row displaced the turn row at every
   * height — including heights with rows to spare.
   */
  interface LayoutVariant {
    showCalmQuota?: boolean;
    keepTurnWithTool?: boolean;
    dropSession?: boolean;
    collapseAgents?: boolean;
    dropEnv?: boolean;
  }

  const assemble = (compression: LayoutVariant): string[] => {
    const lines: string[] = [];
    // The environment row is static for the whole session, so it is the first
    // whole category to go — but it is also where the sandbox badge lives, so
    // that badge moves up to row 1 rather than disappearing with it.
    const keepEnv = Boolean(envLine) && !compression.dropEnv;
    const movedAccessBadge = fullAccess
      ? theme.error('[FULL ACCESS]')
      : accessUnknown
        ? colors.dim('[ACCESS ?]')
        : null;
    lines.push(
      buildRow1(
        !keepEnv ? movedAccessBadge : null
      )
    );
    if (keepEnv && envLine) {
      lines.push(envLine);
    }
    if (healthLine) {
      lines.push(healthLine);
    }
    lines.push(
      ...buildUsageRows(
        compression.showCalmQuota
          ? rateLimitCalmLine ?? rateLimitAlertLine
          : rateLimitAlertLine
      )
    );

    // `turnActivity.since` is the phase start, not the current tool's start,
    // so the two rows carry different numbers: "executing tools for 4m" versus
    // "this command has run 12s". Collapsing them lost the first, which is the
    // one that separates a long grind from a fresh call — and the turn row is
    // also where the `event N ago` staleness marker lives.
    const showTurnWithTool = Boolean(
      compression.keepTurnWithTool && hasRunningTool && turnLine && toolsLine
    );
    if (hasRunningTool && toolsLine && !showTurnWithTool) {
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
    if ((!hasRunningTool || showTurnWithTool) && toolsLine) {
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
  const steps: LayoutVariant[] = [
    { showCalmQuota: true, keepTurnWithTool: true },
    { keepTurnWithTool: true },
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
/**
 * Keep the row this HUD is bound to inside the visible slice.
 *
 * The viewport keeps the first `maxLines` rows and stamps "+N hidden" onto the
 * last of them. With enough open sessions the bound row fell off the end, so
 * the dashboard listed every session except the one you were looking at.
 */
function orderForViewport(
  sessions: readonly SessionOverviewItem[],
  selfSessionId: string | undefined,
  maxLines: number
): readonly SessionOverviewItem[] {
  if (
    selfSessionId === undefined ||
    !Number.isFinite(maxLines) ||
    sessions.length <= maxLines
  ) {
    return sessions;
  }
  const selfIndex = sessions.findIndex(
    (session) => session.id === selfSessionId
  );
  // The last visible row carries the indicator and gets truncated to make
  // room, so "safely visible" stops one row short of the budget.
  if (selfIndex < 0 || selfIndex <= maxLines - 2) {
    return sessions;
  }
  const reordered = [...sessions];
  const [self] = reordered.splice(selfIndex, 1);
  reordered.splice(Math.max(0, maxLines - 2), 0, self);
  return reordered;
}

/**
 * Sized to the suffix the wrapper's own naming scheme varies:
 * `codex-hud-<project>-<hash>-<timestamp>-<pid>`, whose last two segments are
 * 19-21 columns. Wider only re-prints part of the hash every row shares.
 */
const OVERVIEW_ADDRESS_WIDTH = 22;

/**
 * The one field on an overview row the user can act on.
 *
 * Measured live with three sessions open in one project, every row read
 * "prj │ … │ 019ff4ef" — same project name, and a session id that matches
 * nothing they can type. The tmux session name is what `tmux ls` and the
 * session chooser show, and the binding scan already carries it. Truncated
 * from the head because codex-hud names share a
 * `codex-hud-<project>-<hash>-` prefix and differ only in the tail.
 */
function overviewAddress(session: SessionOverviewItem): string {
  if (session.tmuxSession) {
    return truncateStart(
      sanitizeTerminalText(session.tmuxSession),
      OVERVIEW_ADDRESS_WIDTH
    );
  }
  // Not running under a codex-hud pane: the id is all there is.
  return session.id.length > 8 ? session.id.slice(0, 8) : session.id;
}

function renderOverviewLayout(
  data: HudData,
  layout: LayoutConfig,
  width: number,
  maxLines: number
): string[] {
  const scanned = (data.overview?.updatedAt?.getTime() ?? 0) > 0;
  let allSessions = data.overview?.sessions;
  let scanning = false;
  if (!allSessions || allSessions.length === 0) {
    // The snapshot refreshes asynchronously, and the overview cache is cold
    // until the first toggle, so the scan is on screen for a few seconds every
    // time. The session this HUD is bound to needs no scan — it is already on
    // the rest of the pane — and one real row beats a screen of blanks.
    const self = boundSessionAsOverviewItem(data);
    if (!scanned && self) {
      allSessions = [self];
      scanning = true;
    } else {
      return [
        colors.dim(scanned ? 'No active sessions' : 'Looking for sessions…'),
      ];
    }
  }

  // The weekly quota is the one number that describes the whole fleet rather
  // than any single row, and the overview is where the fleet is. Pressure
  // takes a row from the session list the way it does in the single view;
  // a calm reading only fills a row nothing else wanted.
  const now = Date.now();
  const quotaAlert = renderRateLimitLine(data, width, now);
  const quotaCalm = renderRateLimitLine(data, width, now, {
    includeBelowPressure: true,
  });
  const scanningNote = scanning
    ? colors.dim('Looking for other sessions…')
    : null;
  // The rows are clipped by the viewport, not here, so that its "+N hidden"
  // stamp keeps counting what it actually dropped. Reserving a line therefore
  // means telling orderForViewport that the budget is one smaller.
  const reserved = (quotaAlert ? 1 : 0) + (scanningNote ? 1 : 0);
  const overview = {
    sessions: orderForViewport(
      allSessions,
      data.overviewSelfSessionId,
      Math.max(1, maxLines - reserved)
    ),
  };

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

  // Only worth a column when it separates rows; with one model in play it is
  // the same word repeated down the pane.
  const models = new Set(
    overview.sessions
      .map((session) => session.model)
      .filter((model): model is string => Boolean(model))
  );
  const showModel = models.size > 1;
  const modelDisplays = overview.sessions.map((session) =>
    colors.dim(truncate(sanitizeTerminalText(session.model ?? '--'), 20))
  );
  const modelColumnWidth = showModel
    ? Math.max(...modelDisplays.map((display) => visualLength(display)))
    : 0;

  const rows = overview.sessions.map((session, index) => {
    const parts = [
      padEnd(theme.projectName(projectNames[index]), projectColumnWidth),
      ...(showModel ? [padEnd(modelDisplays[index], modelColumnWidth)] : []),
      padEnd(phaseLabels[index], phaseColumnWidth),
      padEnd(ctxDisplays[index], ctxColumnWidth),
      padEnd(ageDisplays[index], ageColumnWidth),
      colors.dim(overviewAddress(session)),
    ];
    // Mark the row this HUD is bound to; the address column tells the rows
    // apart, but not which one you are already looking at.
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

  if (scanningNote) {
    rows.push(scanningNote);
  }
  if (quotaAlert) {
    // A quota this high outlives the sessions it would be listed under, and
    // the bottom of an overflowing list is exactly where the viewport clips.
    return [quotaAlert, ...rows];
  }
  if (quotaCalm && rows.length < maxLines) {
    rows.push(quotaCalm);
  }
  return rows;
}

/**
 * The bound session as an overview row.
 *
 * Every column the overview shows for it is already collected for the single
 * view, so it can be listed before any scan has run. The tmux address is not
 * among them — that comes from the scan — and the row falls back to the short
 * id until the real snapshot replaces it.
 */
function boundSessionAsOverviewItem(
  data: HudData
): SessionOverviewItem | null {
  const session = data.session;
  if (!session) {
    return null;
  }
  return {
    id: session.id,
    cwd: session.cwd ?? data.project.cwd,
    projectName: data.project.projectName,
    model: session.model,
    turnActivity: data.turnActivity,
    lastActivityAt: data.turnActivity?.lastActivityAt,
    contextUsage: data.contextUsage,
  };
}

/**
 * Render the full HUD output (all lines)
 */
export function renderHud(data: HudData, options: RenderOptions): string[] {
  const layout = options.layout ?? DEFAULT_LAYOUT;

  if (data.displayMode === 'overview') {
    return renderOverviewLayout(
      data,
      layout,
      options.width,
      options.maxLines ?? Number.POSITIVE_INFINITY
    );
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
