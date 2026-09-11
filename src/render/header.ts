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
  SessionOverviewItem,
} from '../types.js';
import { DEFAULT_LAYOUT } from '../types.js';
import {
  colors,
  theme,
  icons,
  inlineSeparator,
  remainingBar,
  getContextColor,
  padEnd,
  sanitizeTerminalText,
  stripAnsi,
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
  renderNoteLine,
  renderAgentSummaryLine,
  renderBindingHintLine,
  renderToolDetailsNotice,
} from './lines/index.js';
import { hudDetailsExpanded } from './detail-level.js';
import { compactSessionTitle } from './session-title.js';
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
/** Longest a session title gets on row 1; the overview column is narrower. */
const SESSION_TITLE_WIDTH = 64;

/**
 * The session's first prompt, visually secondary. Two sessions open in the same
 * project rendered identical headers (measured live: both read `prj`) and the
 * only distinguishing cell was the session id on the last row, which is the
 * first row to go.
 */
function renderSessionTitleCell(title: string | undefined, maxWidth: number, cwd: string): string | null {
  const clean = compactSessionTitle(title, cwd);
  if (!clean) {
    return null;
  }
  return colors.dim(truncate(clean, Math.min(SESSION_TITLE_WIDTH, maxWidth)));
}

/** Cells joining the environment content to row 1 when it rides there. */
const ENV_MERGE_SEPARATOR = '  ';

function renderExpandedLayout(
  data: HudData,
  layout: LayoutConfig,
  width: number,
  maxLines: number = Number.POSITIVE_INFINITY,
  reservedRow1Width: number = 0
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
    data.session?.title, budget, data.session?.cwd ?? data.project.cwd
  );
  const buildRow1 = (suffix: string | null): string => {
    const join = (parts: (string | null)[]): string => parts.filter(Boolean).join(separator);
    const projectLine = renderProjectLine(data, { includeFileStats: fullDetails });
    const usageLine = renderUsageLine(data, layout);
    const all = join([projectLine, identityLine, title(SESSION_TITLE_WIDTH), usageLine, suffix]);
    if (visualLength(all) <= headingWidth) return all;
    if (title(SESSION_TITLE_WIDTH)) {
      const gap = visualLength(separator);
      const fixed = visualLength(join([identityLine, suffix])) + 2 * gap;
      const titleMinimum = Math.min(12, visualLength(title(SESSION_TITLE_WIDTH) ?? ''));
      const projectBudget = headingWidth - fixed - titleMinimum;
      if (projectBudget >= Math.min(12, visualLength(sanitizeTerminalText(data.project.projectName)))) {
        const project = renderProjectLine(data, { includeFileStats: false, maxWidth: projectBudget });
        const task = title(headingWidth - fixed - visualLength(project));
        const row = join([project, identityLine, task, suffix]);
        if (visualLength(row) <= headingWidth) return row;
      }
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
    data.paneFreshSession === true &&
    (data.turnActivity?.phase === 'idle' ||
      data.turnActivity?.phase === 'aborted' ||
      data.turnActivity?.phase === 'failed' ||
      data.turnActivity?.phase === 'interrupted')
      ? truncateAnsi(
          colors.dim(
            `${icons.pending} New session at the prompt · binds on its first message`
          ),
          width
        )
      : null;
  // While the hint stands, the session-scoped rows describe the previous
  // session. They stay (they are the useful "what came before") but recede:
  // at full brightness the stale `Ctx: 24% left` sat directly above a pane
  // footer reading `Context 100% left`, and the biggest number on the HUD
  // contradicted the pane. Account-scoped cells (the quota) keep their color.
  const dimStaleRow = (line: string): string => colors.dim(stripAnsi(line));
  const staleSessionRows = paneFreshLine !== null;

  // Context capacity is actionable and remains ahead of activity history.
  const rawTokenLine = renderTokenLine(data, width);
  const tokenLine =
    staleSessionRows && rawTokenLine ? dimStaleRow(rawTokenLine) : rawTokenLine;
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
          const rawCompressed = renderTokenLine(data, tokenBudget);
          const compressedTokenLine =
            staleSessionRows && rawCompressed
              ? dimStaleRow(rawCompressed)
              : rawCompressed;
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
  const rawToolsLine = renderToolsLine(
    visibleTools, width, nowMs, data.partialHistory,
    data.turnActivity?.phase === 'awaiting-approval',
    data.session?.cwd ?? data.project.cwd
  );
  const toolsLine =
    staleSessionRows && rawToolsLine ? dimStaleRow(rawToolsLine) : rawToolsLine;
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
  const sessionLine = renderSessionDetailLine(data, width, {
    dimStaleCells: staleSessionRows,
  });
  // Nothing bound yet: say so instead of rendering three rows and letting the
  // blank remainder read as a broken HUD.
  const bindingHintLine = renderBindingHintLine(data, width);
  // Receipt for the `t` hotkey; it stands in for the tool row that the `off`
  // mode removes, which is the case with no other on-screen evidence.
  const toolDetailsNotice = toolsLine ? null : renderToolDetailsNotice(width);

  // Same source order as the environment row: session records, then the
  // pane's live launch flags (which override the config file), then config —
  // except where config is blind: a partial history, or a bound session with
  // no rollout at all (0.149 defers the file to the first message), where the
  // overriding flags are exactly what no persisted source can see. A fresh
  // session at the prompt runs the flags, not the previous session's records.
  const sessionSandbox = data.session?.sandboxMode;
  const cliSandbox = data.paneCliPolicy?.sandboxMode;
  const runtimeSandbox =
    data.paneFreshSession === true
      ? cliSandbox ?? sessionSandbox
      : sessionSandbox ?? cliSandbox;
  const runtimeFactsPartial =
    data.partialHistory === true && data.runtimeStateComplete !== true;
  const accessUnknown =
    runtimeSandbox === undefined &&
    (runtimeFactsPartial ||
      (data.boundWithoutRollout === true &&
        data.codexExited !== true &&
        // An exhaustively walked argv with no policy flag proves the config
        // un-overridden; the badge may then trust it again.
        data.paneCliPolicy?.exhaustive !== true));
  const fullAccess =
    runtimeSandbox === 'danger-full-access' ||
    (!accessUnknown &&
      runtimeSandbox === undefined &&
      data.config.sandbox_mode === 'danger-full-access');

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
      ? theme.warning('[FULL ACCESS]')
      : accessUnknown
        ? colors.dim('[ACCESS ?]')
        : null;
    if (envOnRow && envLine) {
      lines.push(buildRow1(null), envLine);
    } else if (mergedRow1 !== null) {
      lines.push(mergedRow1);
    } else {
      lines.push(buildRow1(movedAccessBadge));
    }
    // A request for human action gets a reserved row before diagnostics and
    // capacity. This remains visible even if the minimum frame overflows.
    if (urgentTurn && turnLineShown) lines.push(turnLineShown);
    if (healthLine) {
      lines.push(healthLine);
    }
    if (buildLine && variant.showBuild) {
      lines.push(buildLine);
    }
    lines.push(
      ...buildUsageRows(
        variant.showCalmQuota
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
 * Below this the tail says nothing (`…-20…` was measured at 80 columns), so
 * the column is dropped whole instead of printing a stub.
 */
const OVERVIEW_ADDRESS_MIN_WIDTH = 12;
/** The session's first prompt; narrower than on row 1, it shares a table. */
const OVERVIEW_TITLE_WIDTH = 48;

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
function overviewAddress(
  session: SessionOverviewItem,
  maxWidth: number = OVERVIEW_ADDRESS_WIDTH
): string {
  if (session.tmuxSession) {
    return truncateStart(
      sanitizeTerminalText(session.tmuxSession),
      Math.min(OVERVIEW_ADDRESS_WIDTH, maxWidth)
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
  const healthLine = renderHealthLine({
    ...data,
    protocolHealth: undefined,
    collectorHealth: { overview: data.collectorHealth?.overview },
  }, width);
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
        healthLine ?? colors.dim(scanned ? 'No active sessions' : 'Looking for sessions…'),
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
  const unavailableCount = allSessions.filter((session) => session.unavailable).length;
  const overviewWarning = healthLine ?? (unavailableCount > 0
    ? theme.warning(`${unavailableCount} session log${unavailableCount === 1 ? '' : 's'} unavailable · retrying`)
    : null);
  // The rows are clipped by the viewport, not here, so that its "+N hidden"
  // stamp keeps counting what it actually dropped. Reserving a line therefore
  // means telling orderForViewport that the budget is one smaller.
  const reserved = (quotaAlert ? 1 : 0) + (scanningNote ? 1 : 0) + (overviewWarning ? 1 : 0);
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
    if (session.unavailable) {
      return theme.warning('Unknown');
    }
    // An open session that has never run a turn is not unknown; Codex simply
    // has not written a rollout for it yet.
    if (session.neverStarted) {
      return colors.dim('Ready');
    }
    // A confirmed fresh `/new` prompt outranks the stale phase word: the
    // phase describes the previous session, and the single view one keypress
    // away already says "New session at the prompt".
    if (session.freshPrompt) {
      return colors.dim('New prompt');
    }
    const phase = session.turnActivity?.phase;
    switch (phase) {
      case 'awaiting-approval':
        return theme.warning('Approval');
      case 'running-tool':
        return theme.toolRunning('Tool');
      case 'thinking':
        return theme.toolRunning('Thinking');
      case 'responding':
        return theme.info('Responding');
      case 'aborted':
        return theme.error('Aborted');
      case 'failed':
        return theme.error('Failed');
      case 'interrupted':
        return theme.error('Interrupted');
      case 'exited':
        return colors.dim('Exited');
      case 'idle':
        return colors.dim('Idle');
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
  const desiredProjectWidth = Math.max(
    ...projectNames.map((name) => visualLength(name))
  );
  const phaseLabels = overview.sessions.map((session) => phaseLabel(session));
  const phaseColumnWidth = Math.max(
    ...phaseLabels.map((label) => visualLength(label))
  );

  // Sessions without context data (never started, or a rollout that could not
  // be parsed) must still occupy the gauge column, or every column after them
  // shifts left and the table stops scanning as a table.
  const compactColumns = width < 72;
  const contextText = (session: SessionOverviewItem): string => {
    const ctx = session.freshPrompt || session.unavailable ? undefined : session.contextUsage;
    return ctx
      ? getContextColor(ctx.percent)(`${Math.max(0, 100 - ctx.percent)}%${compactColumns ? '' : ' left'}`)
      : colors.dim('--');
  };
  let ctxDisplays = overview.sessions.map(contextText);
  let ctxColumnWidth = Math.max(...ctxDisplays.map(visualLength));
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
  let showModel = false;
  const modelDisplays = overview.sessions.map((session) =>
    colors.dim(truncate(sanitizeTerminalText(session.model ?? '--'), 20))
  );
  const modelColumnWidth = Math.max(...modelDisplays.map(visualLength));

  // The first prompt of each session, which is how a user tells two rows of
  // the same project apart. It competes with the address for the columns the
  // fixed cells leave over: shown only while the address keeps its minimum.
  const titleDisplays = overview.sessions.map((session) =>
    session.title
      ? theme.value(
          truncate(compactSessionTitle(session.title, session.cwd), OVERVIEW_TITLE_WIDTH)
        )
      : ''
  );
  const desiredTitleWidth = Math.max(
    0,
    ...titleDisplays.map((display) => visualLength(display))
  );
  const columnSeparator = compactColumns ? ' ' : '  ';
  const separatorWidth = visualLength(columnSeparator);
  const markerWidth = 2;
  // Identity, phase and remaining context get a budget before decoration.
  // A narrow table must still tell two sessions in the same project apart.
  const addressMinimum = Math.min(OVERVIEW_ADDRESS_MIN_WIDTH,
    Math.max(...overview.sessions.map((session) => visualLength(overviewAddress(session)))));
  const projectColumnWidth = Math.max(1, Math.min(desiredProjectWidth,
    width - markerWidth - phaseColumnWidth - ctxColumnWidth - addressMinimum - separatorWidth * 3));
  let addressBudget = Math.max(0, Math.min(addressMinimum,
    width - markerWidth - projectColumnWidth - phaseColumnWidth - ctxColumnWidth - separatorWidth * 3));
  const showAddress = addressBudget > 0;
  let spare = width - markerWidth - projectColumnWidth - phaseColumnWidth - ctxColumnWidth
    - (showAddress ? addressBudget : 0) - separatorWidth * (showAddress ? 3 : 2);
  let titleColumnWidth = 0;
  if (desiredTitleWidth > 0 && spare >= separatorWidth + Math.min(8, desiredTitleWidth)) {
    titleColumnWidth = Math.min(desiredTitleWidth, spare - separatorWidth);
    spare -= titleColumnWidth + separatorWidth;
  }
  const overviewBarWidth = layout.barWidth ?? 12;
  if (spare >= overviewBarWidth + 1) {
    const withBars = overview.sessions.map((session) =>
      `${session.contextUsage && !session.freshPrompt && !session.unavailable
        ? remainingBar(session.contextUsage.percent, overviewBarWidth)
        : ' '.repeat(overviewBarWidth)} ${contextText(session)}`);
    const withBarsWidth = Math.max(...withBars.map(visualLength));
    spare -= withBarsWidth - ctxColumnWidth;
    ctxDisplays = withBars;
    ctxColumnWidth = withBarsWidth;
  }
  if (models.size > 1 && spare >= separatorWidth + modelColumnWidth) {
    showModel = true;
    spare -= separatorWidth + modelColumnWidth;
  }
  const showAge = spare >= separatorWidth + ageColumnWidth;
  if (showAge) spare -= separatorWidth + ageColumnWidth;
  if (showAddress) addressBudget += Math.min(spare, OVERVIEW_ADDRESS_WIDTH - addressBudget);

  const rows = overview.sessions.map((session, index) => {
    const parts = [
      padEnd((session.id === data.overviewSelfSessionId ? theme.projectName : theme.value)(
        truncate(projectNames[index], projectColumnWidth)
      ), projectColumnWidth),
      ...(titleColumnWidth ? [padEnd(truncateAnsi(titleDisplays[index], titleColumnWidth), titleColumnWidth)] : []),
      ...(showModel ? [padEnd(modelDisplays[index], modelColumnWidth)] : []),
      padEnd(phaseLabels[index], phaseColumnWidth),
      padEnd(ctxDisplays[index], ctxColumnWidth),
      ...(showAge ? [padEnd(ageDisplays[index], ageColumnWidth)] : []),
      ...(showAddress
        ? [colors.dim(overviewAddress(session, addressBudget))]
        : []),
    ];
    // Mark the row this HUD is bound to; the address column tells the rows
    // apart, but not which one you are already looking at.
    const marker =
      data.overviewSelfSessionId !== undefined &&
      session.id === data.overviewSelfSessionId
        ? theme.info(`${icons.bullet} `)
        : '  ';
    return truncateAnsi(marker + parts.join(columnSeparator), width);
  });

  if (scanningNote) {
    rows.push(scanningNote);
  }
  if (overviewWarning) rows.unshift(truncateAnsi(overviewWarning, width));
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
    title: session.title,
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
      Math.max(1, options.width - Math.min(7, options.reservedRow1Width ?? 0)),
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
    options.maxLines ?? Number.POSITIVE_INFINITY,
    options.reservedRow1Width ?? 0
  );
}
