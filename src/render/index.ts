/**
 * Main renderer module
 * Phase 3: Updated to use new LayoutConfig system
 */

import type { HudData, RenderOptions, LayoutConfig, LayoutMode } from '../types.js';
import { renderHud } from './header.js';
import {
  advanceSpinnerFrame,
  colors,
  padEnd,
  visualLength,
  truncateAnsi,
} from './colors.js';

// ANSI escape codes for cursor/screen control
const CURSOR_HOME = '\x1b[H';
const CLEAR_SCREEN = '\x1b[2J';
const CLEAR_LINE = '\x1b[2K';
const CLEAR_SCROLLBACK = '\x1b[3J';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
// X10 button reporting plus SGR encoding. With reporting on, tmux's root
// WheelUpPane binding sees `mouse_any_flag` and hands wheel and click events
// to the pane (`send-keys -M`) instead of entering copy-mode — which froze
// the view on its last frame, indistinguishable from a dead HUD. The events
// double as controls: click [view] toggles the view; the wheel cycles details.
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l';

let lastStdoutFrame: string | null = null;
let hasEverRendered = false;
// The hint is the only on-screen record of the hotkeys, so it must describe
// the binding this session actually has. It used to teach only the clunky
// path (focus the pane first) even when the wrapper had installed a global
// toggle that works from the Codex pane.
const STATUS_HINT = process.env.CODEX_HUD_TOGGLE_KEY
  ? `[view] • ${process.env.CODEX_HUD_TOGGLE_KEY} view • wheel: details`
  : '[view] • Ctrl+T view • wheel: details';
let viewHotspot: { start: number; end: number } | undefined;

export function isViewToggleClick(column: number, row: number): boolean {
  return row === 1 && viewHotspot !== undefined
    && column >= viewHotspot.start && column <= viewHotspot.end;
}
// The hint is for discoverability; after a few minutes it has served its
// purpose and the first line gets its full width back.
const STATUS_HINT_VISIBLE_MS = 5 * 60_000;
const RENDERER_LOADED_AT = Date.now();
// Once the initial window closes the hint is the only record of the hotkeys,
// so interacting with the pane brings it back instead of leaving the keys
// undiscoverable for the rest of the session.
const STATUS_HINT_RECALL_MS = 5000;
let statusHintUntilMs = 0;

export function revealStatusHint(nowMs: number = Date.now()): void {
  statusHintUntilMs = nowMs + STATUS_HINT_RECALL_MS;
}

function statusHintVisible(): boolean {
  const now = Date.now();
  return (
    now - RENDERER_LOADED_AT < STATUS_HINT_VISIBLE_MS ||
    now < statusHintUntilMs
  );
}

/**
 * Drop the cached frame so the next renderToStdout call repaints from a clean
 * screen (used after a terminal resize). Scrollback clearing remains a
 * first-render-only behavior.
 */
export function invalidateRenderedFrame(): void {
  lastStdoutFrame = null;
  viewHotspot = undefined;
}

/**
 * Paint a minimal frame that depends on no collected data.
 *
 * A render that throws used to leave the last good frame on screen, and with
 * CODEX_HUD_LOG_FILE unset by default the failure reached neither the pane nor
 * the disk. A frozen HUD is indistinguishable from an idle session, so the one
 * thing the failure path must do is look broken.
 */
export function renderFallbackFrame(summary: string): void {
  viewHotspot = undefined;
  try {
    const width = getTerminalWidth();
    const height = Math.max(1, getTerminalHeight());
    const icon = process.env.CODEX_HUD_ASCII === '1' ? '!' : '⚠';
    const text = truncateAnsi(
      colors.red(`${icon} HUD display error · retrying · ${summary}`),
      width
    );
    // Force a full repaint once rendering recovers: this frame bypassed the
    // frame cache, so the cached value no longer describes the screen.
    lastStdoutFrame = null;
    let frameOut = CURSOR_HOME;
    for (let i = 0; i < height; i++) {
      frameOut += CLEAR_LINE + (i === 0 ? text : '') + (i < height - 1 ? '\n' : '');
    }
    process.stdout.write(frameOut);
  } catch {
    // The fallback itself must never throw; a stale frame beats a dead pane.
  }
}

function applyStatusHint(lines: string[], width: number, hint: string): string[] {
  viewHotspot = undefined;
  if (lines.length === 0 || width <= 0) {
    return lines;
  }

  const firstLine = lines[0] ?? '';
  const firstLen = visualLength(firstLine);
  const shownHint = firstLen + 1 + visualLength(hint) <= width ? hint : '[view]';
  const status = colors.dim(shownHint);
  const statusLen = visualLength(status);
  if (statusLen + 1 > width) {
    return lines;
  }

  if (firstLen + 1 + statusLen > width) {
    return lines;
  }

  const padded = padEnd(firstLine, width - statusLen - 1);
  viewHotspot = { start: width - statusLen + 1, end: width - statusLen + 6 };
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
  // Stop mouse reporting before the shell gets the terminal back, then show
  // the cursor.
  process.stdout.write(MOUSE_OFF + SHOW_CURSOR);

  // Clear screen
  process.stdout.write(CLEAR_SCREEN + CURSOR_HOME);
}

/** Ask the terminal to report mouse clicks and wheel motion to stdin. */
export function enableMouseReporting(): void {
  if (process.stdout.isTTY) {
    process.stdout.write(MOUSE_ON);
  }
}

export interface RenderedFrame {
  /** Rows the layout renders when nothing is compressed away. */
  wantedRows: number;
  /** Rows the pane currently has. */
  height: number;
}

/**
 * Output HUD to stdout without screen control
 * Used when running in a tmux pane
 */
export function renderToStdout(data: HudData): RenderedFrame {
  const width = getTerminalWidth();
  const height = getTerminalHeight();
  const layout = createDefaultLayout(width, height);
  const clearScrollback = process.env.CODEX_HUD_CLEAR_SCROLLBACK === '1';
  
  const maxLines = Math.max(1, height);
  const hintVisible = statusHintVisible();
  const hint = hintVisible ? STATUS_HINT : '[view]';
  const options: RenderOptions = {
    width,
    showDetails: true,
    layout,
    // The layout compresses low-signal rows to this budget; the viewport fit
    // below stays as a backstop for the cases it cannot compress away.
    maxLines,
    // The hint is appended to row 1 below; the layout must not fill those
    // columns while it is on screen.
    reservedRow1Width: visualLength(hint) + 1,
  };

  // One spinner step per painted frame, whatever the render cadence.
  advanceSpinnerFrame();
  const fitted = fitLinesToViewport(renderHud(data, options), maxLines, width);
  const lines = truncateLines(
    applyStatusHint(fitted, width, hint),
    width
  );
  // What the pane would need to show everything; the height fitter asks tmux
  // for it. The unclipped layout is a second cheap string render.
  const rendered: RenderedFrame = {
    wantedRows: renderHud(data, {
      ...options,
      maxLines: Number.POSITIVE_INFINITY,
    }).length,
    height,
  };

  const frame = `${width}x${height}\n${lines.join('\n')}`;
  if (frame === lastStdoutFrame) {
    return rendered;
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
  return rendered;
}
