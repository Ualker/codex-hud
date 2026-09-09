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

export function getCodexHome(): string {
  const candidates = [
    process.env.CODEX_HOME,
    path.join(os.homedir(), '.codex'),
    path.join(os.homedir(), '.codex_home'),
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

/** Share quota state only between HUDs reading the same Codex data source. */
export function getCodexDataNamespace(): string {
  let home: string;
  try { home = getCodexHome(); }
  catch { home = path.resolve(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')); }
  const candidate = process.env.CODEX_SESSIONS_PATH ?? path.join(home, 'sessions');
  const sessions = resolveExistingDirectory(candidate) ?? path.resolve(candidate);
  return createHash('sha256').update(JSON.stringify([home, sessions])).digest('hex').slice(0, 16);
}
