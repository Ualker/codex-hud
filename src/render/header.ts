import { runtimePermissions } from '../utils/runtime-permissions.js';
import { renderOverviewLayout } from './overview.js';
import { rateLimitAlertKind } from './lines/activity-line.js';
/**
 * Header line renderer
 * 
 * Layout:
 * Row 1: project-name git:(branch *)  model effort  title  [view]
 * Row 2: permissions and Fast mode (inventory in full details)
 * Row 3: collector/protocol health warnings when needed
 * Row 4: context remaining, compactions and rate-limit pressure
 * Row 5+: live turn/tool/agent activity and plan; diagnostics/history in full details
 */

import type {
  AgentActivity,
  HudData,
  RenderOptions,
  LayoutConfig,
} from '../types.js';
import { DEFAULT_LAYOUT } from '../types.js';
import {
  colors,
  theme,
  icons,
  inlineSeparator,
  sanitizeTerminalText,
  stripAnsi,
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
  renderNoteLine,
  renderAgentSummaryLine,
  renderBindingHintLine,
  renderToolDetailsNotice,
} from './lines/index.js';
import { hudDetailsExpanded } from './detail-level.js';
import { compactSessionTitle } from './session-title.js';
import { renderHelp } from './help.js';

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
  if (data.paneFreshSession) parts.push(colors.dim('New session · awaiting first message'));

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
/** Longest a session title gets on row 1; the overview column is narrower. */
const SESSION_TITLE_WIDTH = 64;

/**
 * The session's first prompt identifies the task. Two sessions open in the same
 * project rendered identical headers (measured live: both read `prj`) and the
 * only distinguishing cell was the session id on the last row, which is the
 * first row to go.
 */
function renderSessionTitleCell(title: string | undefined, maxWidth: number, cwd: string): string | null {
  const clean = compactSessionTitle(title, cwd);
  if (!clean) {
    return null;
  }
  return colors.bold(truncate(clean, Math.min(SESSION_TITLE_WIDTH, maxWidth)));
}

/** Cells joining the environment content to row 1 when it rides there. */
const ENV_MERGE_SEPARATOR = '  ';

function renderExpandedLayout(
  data: HudData,
  layout: LayoutConfig,
  width: number,
  maxLines: number = Number.POSITIVE_INFINITY,
  reservedRow1Width: number = 0,
  measure?: { wantedRows: number }
): string[] {
  const separator = layout.showSeparators ? inlineSeparator() : '  ';
  // The small view button stays reachable even with a long project/model.
  // The longer teaching hint uses spare space without evicting the title.
  const headingWidth = Math.max(1, width - Math.min(7, reservedRow1Width));

  const fullDetails = hudDetailsExpanded();
  // Retain useful title text before uptime or a long branch. Variable cells
  // use the remaining budget instead of disappearing as one whole cell.
  const identityLine = renderIdentityLine(data, layout, {
    maxWidth: headingWidth, showContext: false, framed: false,
  });
  const title = (budget: number): string | null => renderSessionTitleCell(
    data.sessionLabel || data.session?.title, budget, data.session?.cwd ?? data.project.cwd
  );
  const buildRow1 = (suffix: string | null): string => {
    const join = (parts: (string | null)[]): string => parts.filter(Boolean).join(separator);
    const projectLine = renderProjectLine(data, { includeFileStats: fullDetails, emphasizeName: !title(SESSION_TITLE_WIDTH) });
    const usageLine = renderUsageLine(data, layout);
    const all = join([projectLine, identityLine, title(SESSION_TITLE_WIDTH), usageLine, suffix]);
    if (visualLength(all) <= headingWidth) return all;
    if (title(SESSION_TITLE_WIDTH)) {
      const gap = visualLength(separator);
      const fixed = visualLength(join([identityLine, suffix])) + 2 * gap;
      const titleMinimum = Math.min(12, visualLength(title(SESSION_TITLE_WIDTH) ?? ''));
      const projectBudget = headingWidth - fixed - titleMinimum;
      if (projectBudget >= Math.min(12, visualLength(sanitizeTerminalText(data.project.projectName)))) {
        const project = renderProjectLine(data, { includeFileStats: false, maxWidth: projectBudget, emphasizeName: false });
        const task = title(headingWidth - fixed - visualLength(project));
        const row = join([project, identityLine, task, suffix]);
        if (visualLength(row) <= headingWidth) return row;
      }
      // On narrow panes preserve the task before long model/branch metadata.
      const project = colors.dim(truncate(sanitizeTerminalText(data.project.projectName), 12));
      const budget = headingWidth - visualLength(join([project, suffix])) - 2 * gap;
      if (budget >= 8) return join([project, title(budget), suffix]);
    }
    const withoutTitle = join([projectLine, identityLine, suffix]);
    if (visualLength(withoutTitle) <= headingWidth) return withoutTitle;
    const gap = visualLength(separator);
    const contentWidth = Math.max(0,
      headingWidth - (suffix ? visualLength(suffix) + gap : 0));
    if (contentWidth === 0) return truncateAnsi(suffix ?? '', headingWidth);
    const projectMinimum = Math.min(
      visualLength(sanitizeTerminalText(data.project.projectName)),
      12,
      Math.max(0, contentWidth - gap - 8)
    );
    const shrunkIdentity = renderIdentityLine(data, layout, {
      maxWidth: Math.max(1, contentWidth - (projectMinimum ? projectMinimum + gap : 0)),
      showContext: false,
      framed: false,
    });
    const shrunkProject = renderProjectLine(data, {
      includeFileStats: false,
      maxWidth: Math.max(0, contentWidth - visualLength(shrunkIdentity) - gap),
    });
    return truncateAnsi(
      [shrunkProject, shrunkIdentity, suffix].filter(Boolean).join(separator),
      headingWidth
    );
  };

  const envOptions = { compact: !fullDetails };
  const envLine = renderEnvironmentLine(data, width, envOptions);
  // Row 1 can host the environment cells when every one of them fits beside
  // it (minus the hotkey hint's reservation while that is on screen). The
  // environment row is static for the whole session, and at the live 146x7
  // geometry row 1 had about a hundred columns to spare, so merging it frees
  // a row for live state without dropping a single cell. Only a complete
  // merge counts: a partial one would trade cells for the row.
  const envFull = renderEnvironmentLine(data, Number.POSITIVE_INFINITY, envOptions);
  const row1Plain = buildRow1(null);
  const mergedRow1 =
    envFull !== null &&
    visualLength(row1Plain) +
      ENV_MERGE_SEPARATOR.length +
      visualLength(envFull) <=
      width - reservedRow1Width
      ? `${row1Plain}${ENV_MERGE_SEPARATOR}${envFull}`
      : null;
  const canMergeEnv = mergedRow1 !== null;

  // Collector/protocol warnings outrank ordinary usage details.
  const healthLine = renderHealthLine(data, width);
  // Unknown top-level record types and slow probes are a dim note, not a
  // warning, and the last row the budget ladder hands out.
  const noteLine = renderNoteLine(data, width);
  // The pane keeps rendering with whatever build it was spawned on; after a
  // rebuild this is the one place that says so, and the fix is one command.
  const buildLine =
    data.hudBuildUpdated === true
      ? truncateAnsi(
          colors.dim('HUD updated on disk · codex-hud --reload'),
          width
        )
      : null;

  // A fresh `/new` session at the prompt is invisible to every data source
  // until its first message (codex 0.149 creates the rollout, the threads
  // row, and the open-file footprint lazily), so the bound session's last
  // state — measured live as "✗ Turn aborted · event 5h ago" — would stand
  // indefinitely. Only quiet terminal phases are overridden: a working phase
  // is live proof the pane still runs the bound session, and `exited` is the
  // more specific fact.
  const paneFreshLine =
    data.paneFreshSession === true
      ? truncateAnsi(
          colors.dim(
            `${icons.pending} New session at the prompt · binds on its first message`
          ),
          width
        )
      : null;
  // renderHud removes the previous session's data while this hint stands.
  const staleSessionRows = paneFreshLine !== null;

  // Context capacity is actionable and remains ahead of activity history.
  const tokenLine = renderTokenLine(data, width);
  // Two readings of the same account quota: the alert form only appears under
  // pressure, the calm form always states where the window stands. The calm
  // one is worth a row only when there is one to spare, so the ladder picks.
  const rateLimitAlertLine = renderRateLimitLine(data, width);
  const urgentQuota = rateLimitAlertKind(data.rateLimits, Date.now()) !== null ? rateLimitAlertLine : null;
  const rateLimitCalmLine = renderRateLimitLine(data, width, Date.now(), {
    includeBelowPressure: true,
  });
  const buildUsageRows = (rateLimitLine: string | null): string[] => {
    const rows: string[] = [];
    if (tokenLine) {
      const usageSeparator = inlineSeparator();
      let displayedTokenLine = tokenLine;
      let combined = rateLimitLine
        ? `${displayedTokenLine}${usageSeparator}${rateLimitLine}`
        : displayedTokenLine;
      if (rateLimitLine && visualLength(combined) > width) {
        const tokenBudget =
          width - visualLength(usageSeparator) - visualLength(rateLimitLine);
        // Near the real 146-column geometry, dropping token breakdown cells
        // saves a whole row and keeps the account quota visible. Below this
        // floor the context gauge itself would be sacrificed to a calm quota,
        // so the two signals stay on separate rows and the layout ladder picks.
        if (tokenBudget >= 80) {
          const compressedTokenLine = renderTokenLine(data, tokenBudget);
          if (compressedTokenLine) {
            const compressed =
              `${compressedTokenLine}${usageSeparator}${rateLimitLine}`;
            if (visualLength(compressed) <= width) {
              displayedTokenLine = compressedTokenLine;
              combined = compressed;
            }
          }
        }
      }
      if (visualLength(combined) <= width) {
        rows.push(combined);
      } else {
        rows.push(displayedTokenLine);
        if (rateLimitLine) {
          rows.push(rateLimitLine);
        }
      }
    } else if (rateLimitLine) {
      rows.push(rateLimitLine);
    }
    return rows;
  };

  const exited = data.turnActivity?.phase === 'exited';
  const runningCalls = exited ? [] : (data.toolActivity?.runningCalls ??
    data.toolActivity?.recentCalls.filter((call) => call.status === 'running') ?? []);
  const hasRunningTool = runningCalls.length > 0;
  const nowMs = Date.now();
  const finishedCalls = data.toolActivity?.recentCalls.filter((call) => call.status !== 'running') ?? [];
  // Default: live calls and actionable recent failures. Old completed/error
  // history is still available explicitly, without looking like current work.
  const recentCalls = fullDetails ? [...finishedCalls, ...runningCalls] : [
    ...finishedCalls.filter((call) => call.status === 'error' && !staleSessionRows &&
      !exited && data.turnActivity?.phase !== 'idle' &&
      (data.turnActivity?.phase === 'failed' || nowMs - call.timestamp.getTime() - (call.duration ?? 0) < 60_000)),
    ...runningCalls,
  ];
  const visibleTools = data.toolActivity ? {
    ...data.toolActivity, runningCalls, recentCalls,
    totalCalls: fullDetails ? data.toolActivity.totalCalls : recentCalls.length,
  } : undefined;
  const toolsLine = renderToolsLine(
    visibleTools, width, nowMs, data.partialHistory,
    data.turnActivity?.phase === 'awaiting-approval',
    data.session?.cwd ?? data.project.cwd
  );
  const turnLine = renderTurnActivityLine(data.turnActivity, width);
  const turnLineShown = paneFreshLine ?? turnLine;
  const awaitingApproval =
    data.turnActivity?.phase === 'awaiting-approval';
  const urgentTurn = Boolean(turnLineShown &&
    ['awaiting-approval', 'failed', 'interrupted', 'aborted'].includes(data.turnActivity?.phase ?? '') &&
    !paneFreshLine);
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

  const { sandboxMode: runtimeSandbox } = runtimePermissions(data);
  const accessUnknown = runtimeSandbox === undefined;
  const fullAccess = runtimeSandbox === 'danger-full-access';

  /**
   * The rows the budget can hand out, each independent of the others. The
   * frame is assembled from the most compressed shape and the features are
   * added back by value, so a taller pane only ever shows more.
   */
  interface LayoutVariant {
    /** One row per agent instead of the `N agents` count. */
    expandAgents: boolean;
    /** The turn row beside the running-tool row: it counts a different thing. */
    keepTurnWithTool: boolean;
    /** The calm quota reading (pressure always renders). */
    showCalmQuota: boolean;
    /** The environment content on its own row rather than row 1 or the badge. */
    envRow: boolean;
    showSession: boolean;
    /** The dim unknown-record note. */
    showNote: boolean;
    showBuild: boolean;
  }

  const assemble = (variant: LayoutVariant): string[] => {
    const lines: string[] = [];
    const envOnRow = Boolean(envLine) && variant.envRow;
    // Without its own row the environment content rides on row 1 when it
    // fits; otherwise only the sandbox badge moves up, so the permission mode
    // never disappears with the row.
    const movedAccessBadge = fullAccess
      ? theme.info('[FULL ACCESS]')
      : accessUnknown
        ? colors.dim('[ACCESS ?]')
        : null;
    if (envOnRow && envLine) {
      lines.push(buildRow1(null));
    } else if (mergedRow1 !== null) {
      lines.push(mergedRow1);
    } else {
      lines.push(buildRow1(movedAccessBadge));
    }
    // A request for human action gets a reserved row before diagnostics and
    // capacity. This remains visible even if the minimum frame overflows.
    if (urgentTurn && turnLineShown) lines.push(turnLineShown);
    if (urgentQuota) lines.push(urgentQuota);
    if (healthLine) {
      lines.push(healthLine);
    }
    if (buildLine && variant.showBuild) {
      lines.push(buildLine);
    }
    lines.push(
      ...buildUsageRows(
        urgentQuota ? null : variant.showCalmQuota
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
      variant.keepTurnWithTool &&
        hasRunningTool &&
        turnLineShown &&
        toolsLine
    );
    if (urgentTurn) {
      // Already pinned above; paused tool details can use any spare row.
    } else if (hasRunningTool && toolsLine && !showTurnWithTool) {
      // A suspended call is detail about the approval wait, not the primary
      // state. When one row must win, keep the action the user can take and
      // drop the paused tool detail instead of showing a fake running spinner.
      lines.push(awaitingApproval && turnLineShown ? turnLineShown : toolsLine);
    } else if (turnLineShown) {
      lines.push(turnLineShown);
    } else if (bindingHintLine) {
      lines.push(bindingHintLine);
    }

    if (!variant.expandAgents && agentSummaryLine) {
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
    if (envOnRow && envLine) lines.push(envLine);
    // Static identity (Dir/Session/CLI) never changes mid-session; keep it
    // last so small panes hide it before live plan/tool state.
    if (fullDetails && sessionLine && variant.showSession) {
      lines.push(sessionLine);
    }
    if (noteLine && variant.showNote) {
      lines.push(noteLine);
    }

    return lines;
  };

  const everything: LayoutVariant = {
    expandAgents: true,
    keepTurnWithTool: true,
    showCalmQuota: true,
    envRow: true,
    showSession: true,
    showNote: true,
    showBuild: true,
  };
  if (measure) measure.wantedRows = assemble(everything).length;
  if (!Number.isFinite(maxLines)) {
    return assemble(everything);
  }

  // Start from the most compressed frame and add rows back by value, keeping
  // each addition only while the frame still fits. A linear ladder used to
  // stop at the first rung that fit: at the live 146x7 geometry it left one
  // row blank with three agents on screen, and it could never reach "turn row
  // plus collapsed agents", which fit exactly — while the static environment
  // row outlived the turn row and its staleness marker.
  //
  // With its content merged onto row 1 the environment row is cosmetic and
  // comes last; when it cannot be merged it still yields to live turn state
  // but outranks the static session row it used to outlive.
  const order: (keyof LayoutVariant)[] = canMergeEnv
    ? ['expandAgents', 'keepTurnWithTool', 'showCalmQuota', 'showSession', 'envRow', 'showBuild', 'showNote']
    : ['expandAgents', 'keepTurnWithTool', 'showCalmQuota', 'envRow', 'showSession', 'showBuild', 'showNote'];
  let variant: LayoutVariant = {
    expandAgents: false,
    keepTurnWithTool: false,
    showCalmQuota: false,
    envRow: false,
    showSession: false,
    showNote: false,
    showBuild: false,
  };
  let rendered = assemble(variant);
  if (rendered.length > maxLines) {
    // Nothing left to give back; the viewport clips what remains.
    return rendered;
  }
  for (const feature of order) {
    const candidate = { ...variant, [feature]: true };
    const lines = assemble(candidate);
    if (lines.length <= maxLines) {
      variant = candidate;
      rendered = lines;
    }
  }
  return rendered;
}

/**
 * Render the full HUD output (all lines)
 */
/** A companion to Codex's native status line: activity first, calm capacity in details. */
function renderCoexistLayout(data: HudData, layout: LayoutConfig, width: number, maxLines: number, reservedRow1Width: number): string[] {
  const title = sanitizeTerminalText(data.sessionLabel || data.session?.title || data.project.projectName);
  const headingWidth = Math.max(1, width - Math.min(7, reservedRow1Width));
  let label = colors.bold(truncate(title, Math.max(1, Math.min(headingWidth, Math.floor(width * .5)))));
  let environment = renderEnvironmentLine(data, Math.max(0, headingWidth - visualLength(label) - 2), { compact: true });
  if (!environment) {
    const sandbox = runtimePermissions(data).sandboxMode;
    const badge = sandbox === 'danger-full-access' ? '[FULL ACCESS]' : sandbox === undefined ? '[ACCESS ?]' : null;
    if (badge && headingWidth >= badge.length) {
      environment = theme.info(badge);
      label = colors.bold(truncate(title, Math.max(0, headingWidth - badge.length - 2)));
    }
  }
  const identity = [label, environment].filter(Boolean).join('  ');
  const suppressTools = data.paneFreshSession || data.turnActivity?.phase === 'exited';
  const phase = data.turnActivity?.phase;
  const now = Date.now();
  const liveTools = data.toolActivity && !suppressTools ? {
    ...data.toolActivity,
    recentCalls: data.toolActivity.recentCalls.filter(call =>
      call.status === 'running' || (call.status === 'error' && phase !== 'idle' &&
        (phase === 'failed' || now - call.timestamp.getTime() - (call.duration ?? 0) < 60_000))),
  } : undefined;
  // Actionable state and capacity precede expandable agent/history rows.
  const state = data.paneFreshSession
    ? colors.dim('New session at the prompt · binds on its first message')
    : renderTurnActivityLine(data.turnActivity, width) ?? renderBindingHintLine(data, width);
  const rows = [
    identity, state,
    rateLimitAlertKind(data.rateLimits, now) !== null ? renderRateLimitLine(data, width, now) : null,
    renderHealthLine(data, width),
    rateLimitAlertKind(data.rateLimits, now) === null
      ? renderRateLimitLine(data, width, now, { includeBelowPressure: data.paneFreshSession === true }) : null,
  ];
  if (!data.paneFreshSession && (hudDetailsExpanded() || (data.contextUsage?.percent ?? 0) >= 70)) {
    rows.push(renderTokenLine(data, width));
  }
  rows.push(renderToolsLine(liveTools, width, now, data.partialHistory, phase === 'awaiting-approval', data.project.cwd));
  const agents = renderAgentLines(data.agentActivity, width);
  const remaining = Math.max(0, maxLines - rows.filter(Boolean).length);
  if (agents.length > remaining && remaining > 0) {
    rows.push(...agents.slice(0, remaining - 1),
      colors.dim(`Agents: ${data.agentActivity?.visibleAgentCount ?? agents.length} active · d details`));
  } else {
    rows.push(...agents);
  }
  rows.push(renderTodosLine(data.planProgress, width));
  if (hudDetailsExpanded()) {
    rows.push(renderSessionDetailLine(data, width), renderNoteLine(data, width));
  }
  return rows.filter((row): row is string => Boolean(row)).map(row => truncateAnsi(row, width));
}

export function renderHud(data: HudData, options: RenderOptions): string[] {
  if (process.env.CODEX_HUD_HIDE_TITLES === '1') {
    data = { ...data,
      session: data.session ? { ...data.session, title: undefined } : undefined,
      overview: data.overview ? { ...data.overview, sessions: data.overview.sessions.map(row => ({ ...row, title: row.label })) } : undefined,
    };
  }
  let layout = options.layout ?? DEFAULT_LAYOUT;
  // A live working/exited phase is newer evidence than the cached footer.
  const freshSession = data.paneFreshSession === true && (!data.turnActivity ||
    ['idle', 'aborted', 'failed', 'interrupted'].includes(data.turnActivity.phase));
  if (freshSession && data.displayMode !== 'overview') {
    data = { ...data, session: undefined, contextUsage: undefined, tokenUsage: undefined,
      toolActivity: undefined, agentActivity: undefined, planProgress: undefined,
      protocolHealth: undefined, partialHistory: undefined, runtimeStateComplete: false,
      boundWithoutRollout: false };
    layout = { ...layout, showDuration: false };
  } else if (data.paneFreshSession && !freshSession) {
    data = { ...data, paneFreshSession: false };
  }
  const width = options.width;
  let rows: string[];
  if (data.helpVisible) {
    rows = renderHelp(data, width, options.maxLines);
  } else if (data.displayMode === 'overview') {
    rows = renderOverviewLayout(data,layout,Math.max(1,width-Math.min(7,options.reservedRow1Width ?? 0)),options.maxLines ?? Infinity);
  } else if (data.layoutPreset === 'coexist') {
    rows = renderCoexistLayout(data,layout,width,options.maxLines ?? Infinity,options.reservedRow1Width ?? 0);
  } else if (layout.mode === 'compact') {
    rows = renderCompactLayout(data,layout,width);
  } else {
    return renderExpandedLayout(data,layout,width,options.maxLines ?? Infinity,options.reservedRow1Width ?? 0,options.measure);
  }
  if(options.measure) options.measure.wantedRows=rows.length;
  return rows;
}
