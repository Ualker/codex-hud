import type { HudData } from '../types.js';
import { filteredSessions, selectedSession } from '../ui/state.js';
import { sanitizeTerminalText, theme, truncateAnsi, visualLength } from './colors.js';
import { formatCompactAge } from '../utils/format-age.js';

/** Complete targets and actionable health details stay readable in a five-row pane. */
export function renderInspection(data: HudData, width: number, maxLines = 5): string[] {
  const selected = data.displayMode === 'overview'
    ? selectedSession(filteredSessions(data.overview?.sessions ?? [], data.overviewFilter ?? 'all'),
      data.overviewSelectionId, data.overviewSelfSessionId) : undefined;
  const target = selected?.tmuxSession ?? data.hudSession;
  const entries = [
    `Target: ${target ?? 'no tmux target'}`,
    `Session: ${selected?.id ?? data.session?.id ?? 'not bound yet'}`,
    `Directory: ${selected?.cwd ?? data.project.cwd}`,
    ...(selected ? [
      `Selected state: ${selected.unavailable ? 'session log unavailable' : selected.turnActivity?.phase ?? 'waiting for first turn'}`,
      'Enter in overview: open this target',
    ] : [
      `Binding: ${data.bindingInfo?.source ?? 'unknown'}`,
      ...(data.bindingInfo?.error ? [`Reason: ${data.bindingInfo.error}`] : []),
      ...(!data.session ? ['Send a message in Codex to create a rollout; check --doctor if binding stays unavailable.'] : []),
    ]),
    'This HUD collectors:',
    ...Object.entries(data.collectorHealth ?? {}).flatMap(([name, health]) => health ? [
      `${name}: ${health.status}${health.lastSuccessAt ? ` · ${formatCompactAge(Date.now() - health.lastSuccessAt.getTime())} old` : ''}`,
      ...(health.errorSummary ? [`Reason: ${health.errorSummary}`] : []),
    ] : []),
    `Log backlog: ${data.pendingBytes ?? 0} bytes`,
    `Quota: ${data.rateLimitsSource ?? 'unavailable'}${data.rateLimitsObservedAt ? ` · ${formatCompactAge(Date.now() - data.rateLimitsObservedAt.getTime())} old` : ''}`,
    'Diagnostics: codex-hud --doctor --json',
    'r: rename this HUD for an easier-to-recognize title',
  ];
  const lines: string[] = [];
  for (const entry of entries) {
    let row = '';
    for (const character of sanitizeTerminalText(entry)) {
      if (row && visualLength(row + character) > width) { lines.push(row); row = ''; }
      row += character;
    }
    if (row) lines.push(row);
  }
  const height = Math.max(3, Math.min(12, Number.isFinite(maxLines) ? maxLines : 5));
  const pageSize = height - 2;
  const pages = Math.max(1, Math.ceil(lines.length / pageSize));
  const page = ((data.inspectionPage ?? 0) % pages + pages) % pages;
  return [theme.info(`HUD info ${page + 1}/${pages} · i close`),
    ...lines.slice(page * pageSize, (page + 1) * pageSize),
    theme.dim('j/k or wheel: pages · Esc close'),
  ].map(row => truncateAnsi(row, width));
}
