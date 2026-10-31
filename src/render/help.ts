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
      `${toggle}: switch view · t: tool text (${toolDetailsMode()}) · d: history/info (${details})`,
      'Overview: j/k or arrows select · Enter: open selected · f all/attention',
      `c: native-status companion (${data.layoutPreset ?? 'standard'}) · saved for this HUD`,
      'Rename: codex-hud --label NAME --reload --target SESSION',
    ].map(row => truncateAnsi(row, width));
  }
  const entries = [
    `${toggle}: switch view`,
    `View: ${data.displayMode ?? 'single'}`,
    `t: tool text (${toolDetailsMode()})`,
    `d: history/info (${details})`,
    `c: layout (${data.layoutPreset ?? 'standard'})`,
    'coexist: companion to native status',
    'Overview: j/k or arrows select',
    'Enter: open selected session',
    'f: all / attention filter',
    'Esc: close / return to Codex',
    'Rename a session from your shell:',
    'codex-hud --label NAME --reload --target SESSION',
    'Choices saved for this HUD',
  ].flatMap(entry => {
    // Wrap commands rather than truncating away required control arguments.
    const rows: string[] = [];
    let row = '';
    for (const word of entry.split(' ')) {
      const next = row ? `${row} ${word}` : word;
      if (next.length > width && row) { rows.push(row); row = word; }
      else row = next;
    }
    if (row) rows.push(row);
    return rows;
  });
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
