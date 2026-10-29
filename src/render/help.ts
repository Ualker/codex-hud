import type { HudData } from '../types.js';
import { sanitizeTerminalText, theme, truncateAnsi } from './colors.js';
import { hudDetailsExpanded } from './detail-level.js';
import { toolDetailsMode } from './lines/activity-line.js';

/** Short entries and pages keep every command discoverable in a narrow pane. */
export function renderHelp(data: HudData, width: number, maxLines = 5): string[] {
  const toggle = sanitizeTerminalText(process.env.CODEX_HUD_TOGGLE_KEY || 'Ctrl+T');
  const details = hudDetailsExpanded() ? 'full' : 'compact';
  if (width >= 90 && maxLines >= 5) {
    return [
      theme.info('HUD help · ? close · Esc: close / return to Codex'),
      `${toggle}: switch view · t tools: ${toolDetailsMode()} · d details: ${details}`,
      'Overview: j/k or arrows select · Enter: open selected · f all/attention',
      `c layout: ${data.layoutPreset ?? 'standard'} · view: ${data.displayMode ?? 'single'} · choices persist`,
      'Set name: codex-hud --label NAME',
    ].map(row => truncateAnsi(row, width));
  }
  const entries = [
    `${toggle}: switch view`,
    `View: ${data.displayMode ?? 'single'}`,
    `t tools: ${toolDetailsMode()}`,
    `d details: ${details}`,
    `c layout: ${data.layoutPreset ?? 'standard'}`,
    'Overview: j/k or arrows select',
    'Enter: open selected session',
    'f: all / attention filter',
    'Esc: close / return to Codex',
    'Set name: codex-hud --label NAME',
    'View/detail choices persist',
  ];
  const height = Math.max(3, Math.min(12, Number.isFinite(maxLines) ? maxLines : 5));
  const pageSize = height - 2;
  const pages = Math.ceil(entries.length / pageSize);
  const page = ((data.helpPage ?? 0) % pages + pages) % pages;
  return [
    theme.info(`HUD help ${page + 1}/${pages} · ? close`),
    ...entries.slice(page * pageSize, (page + 1) * pageSize),
    theme.dim('j/k: help pages · Esc close'),
  ].map(row => truncateAnsi(row, width));
}
