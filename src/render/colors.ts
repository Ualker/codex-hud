/**
 * ANSI color and style utilities for terminal rendering
 * Phase 3: Enhanced to match claude-hud style exactly
 */

// ANSI escape codes
const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const DIM = `${ESC}2m`;
const COLOR_ENABLED =
  process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
const ASCII_MODE = process.env.CODEX_HUD_ASCII === '1';

function ansi(code: string, text: string): string {
  return COLOR_ENABLED ? `${ESC}${code}m${text}${RESET}` : text;
}

// Foreground colors
export const colors = {
  // Basic colors
  black: (text: string) => ansi('30', text),
  red: (text: string) => ansi('31', text),
  green: (text: string) => ansi('32', text),
  yellow: (text: string) => ansi('33', text),
  blue: (text: string) => ansi('34', text),
  magenta: (text: string) => ansi('35', text),
  cyan: (text: string) => ansi('36', text),
  white: (text: string) => ansi('37', text),
  
  // Bright colors
  brightBlack: (text: string) => ansi('90', text),
  brightRed: (text: string) => ansi('91', text),
  brightGreen: (text: string) => ansi('92', text),
  brightYellow: (text: string) => ansi('93', text),
  brightBlue: (text: string) => ansi('94', text),
  brightMagenta: (text: string) => ansi('95', text),
  brightCyan: (text: string) => ansi('96', text),
  brightWhite: (text: string) => ansi('97', text),
  
  // Semantic colors
  dim: (text: string) => ansi('2', text),
  bold: (text: string) => ansi('1', text),
  italic: (text: string) => ansi('3', text),
  underline: (text: string) => ansi('4', text),
};

// Semantic aliases for HUD components (claude-hud style)
export const theme = {
  // Model and primary info
  model: colors.brightCyan,
  modelBracket: colors.cyan,
  
  // Git status (oh-my-zsh style)
  gitBranch: colors.magenta,
  gitClean: colors.green,
  gitDirty: colors.yellow,
  gitAhead: colors.green,
  gitBehind: colors.red,
  gitPrefix: colors.magenta,  // "git:(" prefix
  
  // Project info
  projectName: colors.yellow,  // Changed to yellow like claude-hud
  projectPath: colors.dim,
  
  // Status indicators
  success: colors.green,
  warning: colors.yellow,
  error: colors.red,
  info: colors.cyan,
  
  // Separators and decorations
  separator: colors.dim,
  label: colors.dim,
  value: colors.white,
  dim: colors.dim,
  
  // Context bar colors (based on percentage)
  contextSafe: colors.green,      // < 70%
  contextWarning: colors.yellow,  // 70-84%
  contextDanger: colors.red,      // >= 85%
  
  // Tool activity
  toolRunning: colors.brightYellow,
  toolCompleted: colors.green,
  toolError: colors.red,
  toolName: colors.cyan,
  toolTarget: colors.dim,
  
  // Agent activity
  agentType: colors.brightMagenta,
  agentRunning: colors.brightYellow,
  agentCompleted: colors.green,
  
  // Plan/Todo progress
  planProgress: colors.brightMagenta,
  planStepCompleted: colors.green,
  planStepPending: colors.dim,
  planStepInProgress: colors.yellow,
  
  // Token usage
  tokenCount: colors.brightBlue,
  tokenWarning: colors.yellow,
  tokenDanger: colors.red,
};

// Progress bar characters
export const progressChars = {
  filled: ASCII_MODE ? '#' : '█',
  empty: ASCII_MODE ? '-' : '░',
  half: ASCII_MODE ? '=' : '▓',
};

// Status icons
export const icons = {
  // Git
  dirty: '*',
  ahead: '↑',
  behind: '↓',
  modified: '!',
  added: '+',
  deleted: '✘',
  untracked: '?',
  
  // Activity
  check: ASCII_MODE ? 'OK' : '✓',
  cross: ASCII_MODE ? 'X' : '✗',
  running: ASCII_MODE ? '|' : '◐',       // In-progress spinner character
  spinner: ASCII_MODE ? ['|', '/', '-', '\\'] : ['◐', '◓', '◑', '◒'],
  
  // Info
  clock: '⏱️',
  folder: '📁',
  file: '📄',
  tokens: '🎫',
  plan: '📝',
  tools: '🔧',
  arrow: '→',
  bullet: '▸',
  multiply: '×',
  refresh: '↻',  // For compact count indicator
  
  // Separators
  pipe: '|',
  bar: '│',
};

/**
 * Strip ANSI codes to get visual length
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

/**
 * Make untrusted dynamic labels safe to write to a terminal. Styling is added
 * only after this boundary, so embedded ANSI/OSC/control/bidi sequences cannot
 * alter the HUD or visually reorder text.
 */
export function sanitizeTerminalText(text: string): string {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Approximate the number of terminal cells occupied by a grapheme.
 */
function graphemeWidth(grapheme: string): number {
  if (!grapheme) {
    return 0;
  }
  if (
    grapheme.includes('\u200d') ||
    /\p{Extended_Pictographic}/u.test(grapheme)
  ) {
    return 2;
  }

  let width = 0;
  for (const character of grapheme) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint === 0 ||
      codePoint < 32 ||
      (codePoint >= 0x7f && codePoint < 0xa0) ||
      codePoint === 0x200d ||
      (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
      /\p{Mark}/u.test(character)
    ) {
      continue;
    }

    const isWide =
      codePoint >= 0x1100 &&
      (
        codePoint <= 0x115f ||
        codePoint === 0x2329 ||
        codePoint === 0x232a ||
        (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
        (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
        (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
        (codePoint >= 0xff00 && codePoint <= 0xff60) ||
        (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
        (codePoint >= 0x20000 && codePoint <= 0x3fffd)
      );
    width += isWide ? 2 : 1;
  }
  return width;
}

function segmentGraphemes(text: string): string[] {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, {
      granularity: 'grapheme',
    });
    return [...segmenter.segment(text)].map((part) => part.segment);
  }
  return Array.from(text);
}

function plainVisualLength(text: string): number {
  return segmentGraphemes(text).reduce(
    (total, grapheme) => total + graphemeWidth(grapheme),
    0
  );
}

/**
 * Get visual length of text (excluding ANSI codes).
 */
export function visualLength(text: string): number {
  return plainVisualLength(stripAnsi(text));
}

/**
 * Pad text to specified width (accounting for ANSI codes)
 */
export function padEnd(text: string, width: number): string {
  const currentLength = visualLength(text);
  if (currentLength >= width) return text;
  return text + ' '.repeat(width - currentLength);
}

/**
 * Truncate text to specified width (accounting for ANSI codes)
 */
export function truncate(text: string, maxWidth: number, ellipsis = '…'): string {
  const stripped = stripAnsi(text);
  if (plainVisualLength(stripped) <= maxWidth) return text;
  const limit = Math.max(0, maxWidth - plainVisualLength(ellipsis));
  let output = '';
  let width = 0;
  for (const grapheme of segmentGraphemes(stripped)) {
    const nextWidth = graphemeWidth(grapheme);
    if (width + nextWidth > limit) {
      break;
    }
    output += grapheme;
    width += nextWidth;
  }
  return output + ellipsis;
}

/**
 * Truncate plain text from the start while preserving the most specific tail.
 * Useful for paths where the final directory components carry the most value.
 */
export function truncateStart(text: string, maxWidth: number, ellipsis = '…'): string {
  const stripped = stripAnsi(text);
  if (plainVisualLength(stripped) <= maxWidth) return text;
  if (maxWidth <= 0) return '';

  const ellipsisWidth = plainVisualLength(ellipsis);
  const limit = Math.max(0, maxWidth - ellipsisWidth);
  const graphemes = segmentGraphemes(stripped);
  let output = '';
  let width = 0;
  for (let index = graphemes.length - 1; index >= 0; index--) {
    const grapheme = graphemes[index] ?? '';
    const nextWidth = graphemeWidth(grapheme);
    if (width + nextWidth > limit) {
      break;
    }
    output = grapheme + output;
    width += nextWidth;
  }
  return ellipsis + output;
}

/**
 * Truncate text to a visual width while preserving ANSI sequences.
 */
export function truncateAnsi(text: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0) return '';
  if (visualLength(text) <= maxWidth) return text;

  const limit = Math.max(0, maxWidth - plainVisualLength(ellipsis));
  let out = '';
  let visible = 0;
  let i = 0;
  let sawAnsi = false;

  while (i < text.length && visible < limit) {
    if (text[i] === '\x1b' && text[i + 1] === '[') {
      const match = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(text.slice(i));
      if (!match) break;
      out += match[0];
      sawAnsi = true;
      i += match[0].length;
      continue;
    }

    const nextAnsi = text.indexOf('\x1b[', i);
    const segmentEnd = nextAnsi === -1 ? text.length : nextAnsi;
    const segment = text.slice(i, segmentEnd);
    for (const grapheme of segmentGraphemes(segment)) {
      const width = graphemeWidth(grapheme);
      if (visible + width > limit) {
        i = text.length;
        break;
      }
      out += grapheme;
      visible += width;
      i += grapheme.length;
    }
    if (i < segmentEnd) {
      break;
    }
  }

  const truncated = out + ellipsis;
  if (!sawAnsi) return truncated;
  return truncated + RESET;
}

/**
 * Get the appropriate color function based on context usage percentage
 */
export function getContextColor(percent: number): (text: string) => string {
  if (percent >= 85) {
    return theme.contextDanger;
  } else if (percent >= 70) {
    return theme.contextWarning;
  }
  return theme.contextSafe;
}

/**
 * Create a colored progress bar with percentage-based coloring
 * Matches claude-hud style exactly
 */
export function coloredBar(percent: number, width: number = 10): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  
  const colorFn = getContextColor(clamped);
  
  const filledStr = progressChars.filled.repeat(filled);
  const emptyStr = progressChars.empty.repeat(empty);
  
  return colorFn(filledStr) + colors.dim(emptyStr);
}

/**
 * Create a progress bar (legacy - for non-context bars)
 */
export function progressBar(percent: number, width: number = 10): string {
  return coloredBar(percent, width);
}

/**
 * Format percentage with color based on threshold
 */
export function coloredPercent(percent: number): string {
  const colorFn = getContextColor(percent);
  return colorFn(`${Math.round(percent)}%`);
}

/**
 * Create a separator line
 */
export function separator(width: number): string {
  return colors.dim('─'.repeat(width));
}

/**
 * Get current spinner frame based on time
 */
export function getSpinnerFrame(frameIndex?: number): string {
  const frames = icons.spinner;
  const idx = frameIndex ?? Math.floor(Date.now() / 100) % frames.length;
  return frames[idx];
}
