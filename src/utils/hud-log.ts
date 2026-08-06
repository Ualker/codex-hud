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

// A repeating failure must not grow the log without bound; the file restarts
// once it reaches this size (old contents are diagnostic, not precious).
const LOG_SIZE_LIMIT_BYTES = 5 * 1024 * 1024;

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
    try {
      if (fs.statSync(target).size >= LOG_SIZE_LIMIT_BYTES) {
        fs.writeFileSync(
          target,
          `${new Date().toISOString()} [hud-log] previous contents truncated at ${LOG_SIZE_LIMIT_BYTES} bytes\n`
        );
      }
    } catch {
      // A missing file is created by the append below.
    }
    fs.appendFileSync(
      target,
      `${new Date().toISOString()} [${scope}] ${message}\n`
    );
  } catch {
    // Logging must never break the HUD.
  }
}
