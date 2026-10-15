import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';

function resolveExistingDirectory(candidate?: string): string | null {
  if (!candidate) {
    return null;
  }

  try {
    if (!fs.existsSync(candidate)) {
      return null;
    }

    const resolved = fs.realpathSync(candidate);
    const stats = fs.statSync(resolved);
    if (stats.isDirectory()) {
      return resolved;
    }
  } catch {
    // ignore resolution errors
  }

  return null;
}

export function getCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CODEX_HOME) {
    const resolved = resolveExistingDirectory(env.CODEX_HOME);
    if (!resolved) throw new Error(`CODEX_HOME (${env.CODEX_HOME}) does not exist or is not a directory.`);
    return resolved;
  }
  const candidates = [
    path.join(env.HOME || os.homedir(), '.codex'),
    path.join(env.HOME || os.homedir(), '.codex_home'),
  ];

  for (const candidate of candidates) {
    const resolved = resolveExistingDirectory(candidate);
    if (resolved) {
      return resolved;
    }
  }

  throw new Error(
    'Unable to resolve Codex home. Set CODEX_HOME to the real directory or create ~/.codex (symlinked or not).'
  );
}

export function getSessionsDir(): string {
  if (process.env.CODEX_SESSIONS_PATH) {
    const overridePath = resolveExistingDirectory(process.env.CODEX_SESSIONS_PATH);
    if (!overridePath) {
      throw new Error(
        `CODEX_SESSIONS_PATH (${process.env.CODEX_SESSIONS_PATH}) does not exist or is not a directory.`
      );
    }
    return overridePath;
  }

  const home = getCodexHome();
  const sessionsDir = path.join(home, 'sessions');
  const resolved = resolveExistingDirectory(sessionsDir);
  if (!resolved) {
    throw new Error(
      `Codex sessions directory not found under ${sessionsDir}. Ensure the directory exists and is readable.`
    );
  }

  return resolved;
}

/** Canonicalize existing parents too, so a not-yet-created sessions dir is stable. */
function canonicalDataPath(candidate: string): string {
  try { return fs.realpathSync(candidate); }
  catch {
    const absolute = path.resolve(candidate);
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(canonicalDataPath(parent), path.basename(absolute));
  }
}

/** One scope for attachment, bindings, overview, diagnostics and quota caches. */
export function getCodexDataNamespace(env: NodeJS.ProcessEnv = process.env): string {
  let home: string;
  try { home = getCodexHome(env); }
  catch { home = canonicalDataPath(env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex')); }
  const candidate = env.CODEX_SESSIONS_PATH || path.join(home, 'sessions');
  const sessions = canonicalDataPath(candidate);
  return createHash('sha256').update(JSON.stringify([home, sessions])).digest('hex').slice(0, 16);
}
