/**
 * Main renderer module
 * Phase 3: Updated to use new LayoutConfig system
 */

import type { HudData, RenderOptions, LayoutConfig, LayoutMode } from '../types.js';
import { renderHud } from './header.js';
import { colors, padEnd, visualLength, truncateAnsi } from './colors.js';

// ANSI escape codes for cursor/screen control
const CURSOR_HOME = '\x1b[H';
const CLEAR_SCREEN = '\x1b[2J';
const CLEAR_LINE = '\x1b[2K';
const CLEAR_SCROLLBACK = '\x1b[3J';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

let lastStdoutFrame: string | null = null;
let hasEverRendered = false;
const STATUS_HINT = 'Click HUD: Ctrl+T view • t details • drag resize';
// The hint is for discoverability; after a few minutes it has served its
// purpose and the first line gets its full width back.
const STATUS_HINT_VISIBLE_MS = 5 * 60_000;
const RENDERER_LOADED_AT = Date.now();

function statusHintVisible(): boolean {
  return Date.now() - RENDERER_LOADED_AT < STATUS_HINT_VISIBLE_MS;
}

/**
 * Drop the cached frame so the next renderToStdout call repaints from a clean
 * screen (used after a terminal resize). Scrollback clearing remains a
 * first-render-only behavior.
 */
export function invalidateRenderedFrame(): void {
  lastStdoutFrame = null;
}

function applyStatusHint(lines: string[], width: number): string[] {
  if (lines.length === 0 || width <= 0) {
    return lines;
  }

  const status = colors.dim(STATUS_HINT);
  const statusLen = visualLength(status);
  if (statusLen + 1 > width) {
    return lines;
  }

  const firstLine = lines[0] ?? '';
  const firstLen = visualLength(firstLine);
  if (firstLen + 1 + statusLen > width) {
    return lines;
  }

  const padded = padEnd(firstLine, width - statusLen - 1);
  const nextLines = [...lines];
  nextLines[0] = `${padded} ${status}`;
  return nextLines;
}

/**
 * Get terminal width
 */
export function getTerminalWidth(): number {
  const stdoutColumns = process.stdout.columns;
  if (Number.isFinite(stdoutColumns) && stdoutColumns > 0) {
    return stdoutColumns;
  }
  const envColumns = process.env.COLUMNS ? Number(process.env.COLUMNS) : NaN;
  if (Number.isFinite(envColumns) && envColumns > 0) {
    return envColumns;
  }
  return 80;
}

/**
 * Get terminal height
 */
export function getTerminalHeight(): number {
  const stdoutRows = process.stdout.rows;
  if (Number.isFinite(stdoutRows) && stdoutRows > 0) {
    return stdoutRows;
  }
  const envLines = process.env.LINES ? Number(process.env.LINES) : NaN;
  if (Number.isFinite(envLines) && envLines > 0) {
    return envLines;
  }
  return 24;
}

/**
 * Respect terminal height by trimming lines and adding a truncation indicator when necessary
 */
export function fitLinesToViewport(
  lines: string[],
  maxLines: number,
  width: number
): string[] {
  if (maxLines <= 0) {
    return [];
  }

  if (lines.length <= maxLines) {
    return lines;
  }

  const limited = lines.slice(0, maxLines);
  const truncatedCount = lines.length - maxLines;
  const moreText = `+${truncatedCount} hidden`;
  const indicator = colors.dim(moreText);
  const separatorWidth = 1;
  const available = Math.max(
    0,
    width - visualLength(indicator) - separatorWidth
  );
  const preserved = truncateAnsi(
    limited[limited.length - 1] ?? '',
    available
  );
  limited[limited.length - 1] =
    available > 0 ? `${preserved} ${indicator}` : truncateAnsi(indicator, width);
  return limited;
}

function truncateLines(lines: string[], width: number): string[] {
  if (width <= 0) {
    return [];
  }
  return lines.map((line) => truncateAnsi(line, width));
}

/**
 * Create default layout config based on terminal size
 */
function createDefaultLayout(width: number, height: number): LayoutConfig {
  const mode: LayoutMode = height <= 1 ? 'compact' : 'expanded';
  
  return {
    mode,
    showSeparators: false,
    showDuration: true,
    showContextBreakdown: mode === 'expanded',
    barWidth: Math.min(12, Math.floor(width / 10)),
  };
}

/**
 * Cleanup the renderer
 * Restores terminal state
 */
export function cleanupRenderer(): void {
  // Show cursor
  process.stdout.write(SHOW_CURSOR);

  // Clear screen
  process.stdout.write(CLEAR_SCREEN + CURSOR_HOME);
}

/**
 * Output HUD to stdout without screen control
 * Used when running in a tmux pane
 */
export function renderToStdout(data: HudData): void {
  const width = getTerminalWidth();
  const height = getTerminalHeight();
  const layout = createDefaultLayout(width, height);
  const clearScrollback = process.env.CODEX_HUD_CLEAR_SCROLLBACK === '1';
  
  const options: RenderOptions = {
    width,
    showDetails: true,
    layout,
  };
  
  const maxLines = Math.max(1, height);
  const fitted = fitLinesToViewport(renderHud(data, options), maxLines, width);
  const lines = truncateLines(
    statusHintVisible() ? applyStatusHint(fitted, width) : fitted,
    width
  );

  const frame = `${width}x${height}\n${lines.join('\n')}`;
  if (frame === lastStdoutFrame) {
    return;
  }

  const needsFullClear = lastStdoutFrame === null;
  const isFirstRender = !hasEverRendered;
  hasEverRendered = true;
  lastStdoutFrame = frame;

  // Clear the screen on the first render so the top line reliably appears in
  // new panes, and again after an invalidation (resize) to drop artifacts;
  // hide the cursor at the same time (cleanupRenderer restores it). The
  // scrollback wipe stays strictly first-render-only.
  let frameOut = (isFirstRender && clearScrollback ? CLEAR_SCROLLBACK : '') + (needsFullClear ? HIDE_CURSOR + CLEAR_SCREEN : '') + CURSOR_HOME;

  const totalLines = Math.max(lines.length, maxLines);
  for (let i = 0; i < totalLines; i++) {
    const text = i < lines.length ? lines[i] : '';
    const suffix = i < totalLines - 1 ? '\n' : '';
    frameOut += CLEAR_LINE + text + suffix;
  }
  // One write per frame: fewer syscalls and no partially painted frame when
  // the terminal refreshes mid-update.
  process.stdout.write(frameOut);
}
