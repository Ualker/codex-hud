/**
 * Per-user state files (small persisted values, not diagnostics).
 *
 * Mirrors the resolution chain of hud-log.ts but targets state locations:
 * on macOS that is Application Support, not Logs. The chain matters on this
 * machine specifically — ~/.local/state is root-owned here, so a fixed XDG
 * path would fail every write while looking configured.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function stateDirCandidates(): string[] {
  const home = os.homedir();
  const candidates: string[] = [];
  if (process.platform === 'darwin' && home) {
    candidates.push(
      path.join(home, 'Library', 'Application Support', 'codex-hud')
    );
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

// Resolved once per process; the probe is a few syscalls and the answer
// cannot change for the life of the process.
let resolvedDir: string | null | undefined;

/**
 * Absolute path for a named state file in the first writable candidate
 * directory, or null when none is writable. Never throws.
 */
export function resolveHudStateFile(fileName: string): string | null {
  if (resolvedDir === undefined) {
    resolvedDir = null;
    for (const dir of stateDirCandidates()) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.W_OK);
        resolvedDir = dir;
        break;
      } catch {
        // Try the next candidate.
      }
    }
  }
  return resolvedDir ? path.join(resolvedDir, fileName) : null;
}
