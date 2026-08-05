/**
 * Diagnostic logging that never writes to the HUD pane.
 *
 * The HUD owns its terminal: anything printed to stdout/stderr lands inside
 * the rendered frame and corrupts it until the next repaint. Diagnostics go
 * to the file named by CODEX_HUD_LOG_FILE when set, and are dropped
 * otherwise. User-visible failure states stay on the collector-health and
 * tracking-error lines, which render inside the frame.
 */

import * as fs from 'fs';

function logFilePath(): string | null {
  return process.env.CODEX_HUD_LOG_FILE || null;
}

export function logHudError(scope: string, error: unknown): void {
  const target = logFilePath();
  if (!target) {
    return;
  }

  const message =
    error instanceof Error ? error.stack ?? error.message : String(error);
  try {
    fs.appendFileSync(
      target,
      `${new Date().toISOString()} [${scope}] ${message}\n`
    );
  } catch {
    // Logging must never break the HUD.
  }
}
