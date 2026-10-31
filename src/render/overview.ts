/** Overview rows, column budgets and selection visibility. */
import type { HudData, LayoutConfig, SessionOverviewItem } from '../types.js';
import { filteredSessions, needsAttention } from '../ui/state.js';
import { colors, theme, icons, remainingBar, getContextColor, padEnd,
  sanitizeTerminalText, truncate, truncateAnsi, truncateStart, visualLength } from './colors.js';
import { renderHealthLine, renderRateLimitLine } from './lines/index.js';
import { hudDetailsExpanded } from './detail-level.js';
import { compactSessionTitle } from './session-title.js';
import { formatCompactAge } from '../utils/format-age.js';

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

export function renderOverviewLayout(
  data: HudData,
  layout: LayoutConfig,
  width: number,
  maxLines: number
): string[] {
  const scanned = (data.overview?.updatedAt?.getTime() ?? 0) > 0;
  const sessions = data.overview?.sessions ?? [];
  const attentionCount = sessions.filter(needsAttention).length;
  const summary = data.overviewFilter === 'attention'
    ? `Attention ${attentionCount}/${sessions.length} · f show all`
    : `All ${sessions.length} · ${attentionCount} need attention · f filter`;
  const summaryLine = data.overview?.namespace ? colors.dim(summary) : null;
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
        ...(summaryLine ? [truncateAnsi(summaryLine, width)] : []),
        healthLine ?? colors.dim(scanned ? 'No active sessions' : 'Looking for sessions…'),
      ];
    }
  }

  allSessions = filteredSessions(allSessions, data.overviewFilter ?? 'all');
  if (!allSessions.length) return [
    ...(summaryLine ? [truncateAnsi(summaryLine, width)] : []),
    colors.dim('No sessions need attention · f: show all'),
  ];

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
  const reserved = (quotaAlert ? 1 : 0) + (scanningNote ? 1 : 0) + (overviewWarning ? 1 : 0) + (summaryLine ? 1 : 0);
  const overview = {
    sessions: orderForViewport(
      allSessions,
      data.overviewSelectionId ?? data.overviewSelfSessionId,
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
    if (session.refreshing) return colors.dim('Updating');
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
      ? colors.bold(
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
  const addressMinimum = Math.min(desiredTitleWidth > 0 && !hudDetailsExpanded() ? 6 : OVERVIEW_ADDRESS_MIN_WIDTH,
    Math.max(...overview.sessions.map((session) => visualLength(overviewAddress(session)))));
  const titleReserve = desiredTitleWidth > 0 ? Math.min(12, desiredTitleWidth) + separatorWidth : 0;
  const projectColumnWidth = Math.max(1, Math.min(desiredProjectWidth,
    width - markerWidth - phaseColumnWidth - ctxColumnWidth - addressMinimum - separatorWidth * 3 - titleReserve));
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
  if (showAddress && (hudDetailsExpanded() || desiredTitleWidth === 0)) addressBudget += Math.min(spare, OVERVIEW_ADDRESS_WIDTH - addressBudget);

  const rows = overview.sessions.map((session, index) => {
    const parts = [
      padEnd((desiredTitleWidth > 0 ? colors.dim : theme.projectName)(
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
    const selected = session.id === data.overviewSelectionId && Boolean(session.tmuxSession);
    const marker = selected ? theme.info('> ') :
      data.overviewSelfSessionId !== undefined &&
      session.id === data.overviewSelfSessionId
        ? theme.info(`${icons.bullet} `)
        : session.tmuxSession ? colors.dim(process.env.CODEX_HUD_ASCII === '1' ? ': ' : '› ') : '  ';
    const row = truncateAnsi(marker + parts.join(columnSeparator), width);
    return selected ? colors.underline(row.replace(/\x1b\[0m/g, '\x1b[0m\x1b[4m')) : row;
  });

  if (scanningNote) {
    rows.push(scanningNote);
  }
  if (overviewWarning) rows.unshift(truncateAnsi(overviewWarning, width));
  if (summaryLine) rows.unshift(truncateAnsi(summaryLine, width));
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
    title: data.sessionLabel || session.title,
    model: session.model,
    turnActivity: data.turnActivity,
    lastActivityAt: data.turnActivity?.lastActivityAt,
    contextUsage: data.contextUsage,
  };
}
