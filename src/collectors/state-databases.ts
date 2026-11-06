import * as fs from 'node:fs';
import * as path from 'node:path';
import { getCodexHome } from '../utils/codex-path.js';

export function getStateDatabaseCandidates(): string[] {
  const codexHome = getCodexHome();
  let entries: string[];

  try {
    entries = fs.readdirSync(codexHome);
  } catch {
    return [];
  }

  return entries
    .filter((entry) => /^state(?:_\d+)?\.sqlite$/.test(entry))
    .map((entry) => path.join(codexHome, entry))
    .filter((entryPath) => {
      try {
        return fs.statSync(entryPath).isFile();
      } catch {
        return false;
      }
    })
    .sort((left, right) => {
      try {
        return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
      } catch {
        return right.localeCompare(left);
      }
    });
}
