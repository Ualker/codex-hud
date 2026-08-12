/**
 * Diagnostic logging that never writes to the HUD pane.
 *
 * The HUD owns its terminal: anything printed to stdout/stderr lands inside
 * the rendered frame and corrupts it until the next repaint. Diagnostics go to
 * a file instead, named by CODEX_HUD_LOG_FILE or, when that is unset, a
 * per-user default. Dropping them by default meant an uncaught exception left
 * no trace anywhere — not on screen, not on disk. Set CODEX_HUD_LOG_FILE=off
 * to keep the old silence. User-visible failure states stay on the
 * collector-health and tracking-error lines, which render inside the frame.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// A repeating failure must not grow the log without bound; the file restarts
// once it reaches this size (old contents are diagnostic, not precious).
const LOG_SIZE_LIMIT_BYTES = 5 * 1024 * 1024;

const LOG_FILE_NAME = 'hud.log';

/**
 * Candidate default directories, most preferred first. The last one is the
 * temp dir, which is per-user on macOS and always writable — the earlier
 * candidates can be missing or owned by another user, and a diagnostics path
 * that silently fails is the problem this default exists to fix.
 */
function defaultLogDirCandidates(): string[] {
  const home = os.homedir();
  const candidates: string[] = [];
  if (process.platform === 'darwin' && home) {
    candidates.push(path.join(home, 'Library', 'Logs', 'codex-hud'));
  }
  const xdgState = process.env.XDG_STATE_HOME;
  if (xdgState) {
    candidates.push(path.join(xdgState, 'codex-hud'));
  } else if (home) {
    candidates.push(path.join(home, '.local', 'state', 'codex-hud'));
  }
  candidates.push(path.join(os.tmpdir(), 'codex-hud'));
  return candidates;
}

// Resolved once: the directory probe costs a few syscalls and the answer
// cannot change for the life of the process.
let resolvedTarget: string | null | undefined;

function logFilePath(): string | null {
  const configured = process.env.CODEX_HUD_LOG_FILE;
  if (configured) {
    return configured.toLowerCase() === 'off' ? null : configured;
  }

  if (resolvedTarget !== undefined) {
    return resolvedTarget;
  }

  resolvedTarget = null;
  for (const dir of defaultLogDirCandidates()) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      resolvedTarget = path.join(dir, LOG_FILE_NAME);
      break;
    } catch {
      // Try the next candidate.
    }
  }
  return resolvedTarget;
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
