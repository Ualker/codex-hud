import { theme, truncateAnsi, truncateStart, sanitizeTerminalText } from './colors.js';

export function renderLabelEditor(draft: string, width: number): string[] {
  return [
    theme.info('Rename this HUD'),
    `Label: ${truncateStart(sanitizeTerminalText(draft), Math.max(0, width - 8))}|`,
    'Enter: save · Esc: cancel',
    'Ctrl+U: clear · empty: use task title',
  ].map(line => truncateAnsi(line, width));
}
