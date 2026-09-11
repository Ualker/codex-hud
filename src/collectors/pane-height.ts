/**
 * tmux side of the content-fitted pane height.
 *
 * The wrapper stores the sizing policy on the tmux session (`@codex_hud_*`
 * options). Resize hooks preserve a manual height; the HUD publishes its
 * target before requesting a resize so its own changes are not mistaken for
 * a drag. Reading settings and applying a height each take one round trip.
 */

import { execFile } from 'child_process';

import { startProbe } from '../utils/probe-latency.js';

const TMUX_TIMEOUT_MS = 8000;
export const FIT_HEIGHT_OPTION = '@codex_hud_fit_height';

export interface PaneHeightSettings {
  /** The wrapper's adaptive policy is on (no explicit CODEX_HUD_HEIGHT). */
  adaptive: boolean;
  minRows: number;
  maxRows: number;
  initialRows?: number;
  manualRows?: number;
}

function tmux(args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const finishProbe = startProbe('tmux');
    execFile(
      'tmux',
      args,
      { encoding: 'utf8', timeout: TMUX_TIMEOUT_MS },
      (error, stdout) => {
        finishProbe();
        resolve(error ? null : stdout);
      }
    );
  });
}

/** Parse `tmux show-options` output (`@name value` per line). */
export function parsePaneHeightSettings(
  output: string
): PaneHeightSettings | null {
  const values = new Map<string, string>();
  for (const line of output.split('\n')) {
    const match = /^(@codex_hud_[a-z_]+)\s+"?([^"]*)"?\s*$/.exec(line.trim());
    if (match) {
      values.set(match[1], match[2]);
    }
  }
  const adaptive = values.get('@codex_hud_height_adaptive');
  if (adaptive === undefined) {
    return null;
  }
  const minRows = Number(values.get('@codex_hud_height_min') ?? '5');
  const maxRows = Number(values.get('@codex_hud_height_max') ?? '12');
  if (
    !Number.isInteger(minRows) ||
    !Number.isInteger(maxRows) ||
    minRows < 1 ||
    maxRows < minRows
  ) {
    return null;
  }
  const initialRows = Number(values.get('@codex_hud_height'));
  const manualRows = Number(values.get('@codex_hud_manual_height'));
  return {
    adaptive: adaptive === '1', minRows, maxRows,
    ...(Number.isInteger(initialRows) && initialRows > 0 ? { initialRows } : {}),
    ...(Number.isInteger(manualRows) && manualRows > 0 ? { manualRows } : {}),
  };
}

export async function readPaneHeightSettings(
  tmuxSession: string
): Promise<PaneHeightSettings | null> {
  const output = await tmux(['show-options', '-t', tmuxSession]);
  return output === null ? null : parsePaneHeightSettings(output);
}

/**
 * Changed content resumes fitting. Publish its target and clear the manual
 * override before resizing, so the hook recognizes this as a program resize.
 */
export async function applyPaneHeight(
  tmuxSession: string,
  paneId: string,
  rows: number
): Promise<boolean> {
  const resized = await tmux([
    'set-option',
    '-t',
    tmuxSession,
    '-q',
    FIT_HEIGHT_OPTION,
    String(rows),
    ';', 'set-option', '-t', tmuxSession, '-q', '@codex_hud_height', String(rows),
    ';', 'set-option', '-t', tmuxSession, '-qu', '@codex_hud_manual_height',
    ';', 'resize-pane', '-t', paneId, '-y', String(rows),
  ]);
  return resized !== null;
}
