/**
 * tmux side of the content-fitted pane height.
 *
 * The wrapper stores the sizing policy on the tmux session (`@codex_hud_*`
 * options) and re-imposes it from the resize hook (bin/codex-hud-resize); the
 * HUD publishes the rows it wants as `@codex_hud_fit_height` so the hook and
 * the pane agree. Both reads and writes are one tmux round trip and every
 * failure disables fitting for this process: a pane whose size the HUD
 * cannot control is exactly the pane the wrapper already sized.
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
  return { adaptive: adaptive === '1', minRows, maxRows };
}

export async function readPaneHeightSettings(
  tmuxSession: string
): Promise<PaneHeightSettings | null> {
  const output = await tmux(['show-options', '-t', tmuxSession]);
  return output === null ? null : parsePaneHeightSettings(output);
}

/**
 * Publish the wanted rows and resize the pane. The option goes first so the
 * hook the resize fires reads the new target rather than snapping back.
 */
export async function applyPaneHeight(
  tmuxSession: string,
  paneId: string,
  rows: number
): Promise<boolean> {
  const set = await tmux([
    'set-option',
    '-t',
    tmuxSession,
    '-q',
    FIT_HEIGHT_OPTION,
    String(rows),
  ]);
  if (set === null) {
    return false;
  }
  const resized = await tmux(['resize-pane', '-t', paneId, '-y', String(rows)]);
  return resized !== null;
}
