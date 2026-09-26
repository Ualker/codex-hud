import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCodexHome, getSessionsDir } from './utils/codex-path.js';
import { DIAGNOSTICS_OPTION } from './utils/diagnostics.js';
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors: string[] = [];
function attempt<T>(fn: () => T): T | null { try {
  return fn();
}
catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
  return null;
} }
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), node: process.version,
  hud: { root, version: attempt(() => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version),
    buildModifiedAt: attempt(() => fs.statSync(path.join(root, 'dist/index.js')).mtime.toISOString()) },
  codexHome: attempt(getCodexHome), sessionsDir: attempt(getSessionsDir),
  notifyConfigured: Boolean(process.env.CODEX_HUD_NOTIFY_CMD),
  panes: [] as object[], errors };
try {
  const { stdout } = await exec('tmux', ['list-panes', '-a', '-F', `#{session_name} #{pane_id} #{pane_dead} #{@codex_hud_pane} #{${DIAGNOSTICS_OPTION}}`], { timeout: 3000, maxBuffer: 1024 * 1024 });
  for (const line of stdout.trim().split('\n')) {
    const match = /^(\S+) (%\d+) ([01]) (%\d+)(?: (\S+))?$/.exec(line);
    if (!match || match[2] !== match[4])
      continue;
    let runtime: Record<string, unknown> | null = null;
    try {
      const value = JSON.parse(Buffer.from(match[5] ?? '', 'base64').toString('utf8'));
      if (value && typeof value === 'object')
        runtime = value;
    }
    catch { /* Older HUD. */ }
    let alive = false;
    if (typeof runtime?.pid === 'number')
      try {
        process.kill(runtime.pid, 0);
        alive = true;
      }
      catch { /* Exited owner. */ }
    const age = typeof runtime?.updatedAt === 'string' ? Date.now() - Date.parse(runtime.updatedAt) : Infinity;
    report.panes.push({ tmuxSession: match[1], pane: match[2], dead: match[3] === '1',
      diagnosticsFresh: alive && match[3] === '0' && age >= 0 && age < 30000, runtime });
  }
}
catch (error) {
  errors.push(`tmux: ${error instanceof Error ? error.message : String(error)}`);
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
