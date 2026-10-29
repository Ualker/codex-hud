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
import { randomUUID } from 'crypto';

/** Refuse shared/symlink targets; migrate our existing directories to 0700. */
export function ensurePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('HUD state directory is not owned by the current user');
  }
  if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
}

/** Reads also repair permissions on caches created by earlier HUD versions. */
export function readPrivateState(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('HUD state file is not owned by the current user');
    }
    if ((stat.mode & 0o777) !== 0o600) fs.fchmodSync(fd, 0o600);
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Exclusive private temp files prevent collisions and symlink following. */
export function writePrivateState(file: string, contents: string): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

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
  candidates.push(path.join(os.tmpdir(), `codex-hud-${process.getuid?.() ?? os.userInfo().username}`));
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
  if (!fileName || path.basename(fileName) !== fileName || fileName === '.' || fileName === '..') return null;
  if (resolvedDir === undefined) {
    resolvedDir = null;
    for (const dir of stateDirCandidates()) {
      try {
        ensurePrivateDirectory(dir);
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
