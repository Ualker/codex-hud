import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getSessionsDir } from '../../dist/utils/codex-path.js';
import { createSessionWatcher } from '../../dist/collectors/file-watcher.js';
import { canonicalSessionMeta, taskStarted, writeRolloutFile } from '../helpers/agent-rollout-fixture.mjs';
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hf-')));
const home = path.join(root, 'home'), codexHome = path.join(home, '.codex'), socket = path.join(root, 'tmux');
fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(socket);
const env = { ...process.env, HOME: home, TMUX_TMPDIR: socket, TERM: 'xterm-256color' };
for (const key of Object.keys(env)) if (/^(CODEX_HUD_|CMUX_)/.test(key) || ['TMUX', 'TMUX_PANE', 'CODEX_HOME', 'CODEX_SESSIONS_PATH'].includes(key)) delete env[key];
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const tmux = args => execFileSync('tmux', args, { env, encoding: 'utf8', timeout: 8000 }).trim();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(50); }
  assert.fail(label);
}
const oldHome = process.env.CODEX_HOME, oldSessions = process.env.CODEX_SESSIONS_PATH, originalHome = process.env.HOME;
let watcher;
try {
  process.env.HOME = home; delete process.env.CODEX_HOME; delete process.env.CODEX_SESSIONS_PATH;
  assert.equal(getSessionsDir(), path.join(codexHome, 'sessions'));
  process.env.CODEX_SESSIONS_PATH = path.join(root, 'bad-override');
  assert.throws(getSessionsDir, /CODEX_SESSIONS_PATH/);
  delete process.env.CODEX_SESSIONS_PATH;
  watcher = createSessionWatcher();
  const seen = []; watcher.onChange(file => { seen.push(file); }); watcher.start();
  tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'first-use', '-x', '120', '-y', '30', 'exec sleep 120']);
  const main = tmux(['display-message', '-p', '-t', 'first-use', '#{pane_id}']);
  const mainPid = tmux(['display-message', '-p', '-t', main, '#{pane_pid}']);
  const command = `exec env CODEX_HUD_CWD=${quote(root)} CODEX_HUD_MAIN_PANE=${quote(main)} CODEX_HUD_TMUX_SESSION=first-use CODEX_HUD_HEIGHT_FIT=0 CODEX_HUD_LOG_FILE=${quote(path.join(root, 'hud.log'))} ${quote(process.execPath)} ${quote(path.join(process.cwd(), 'dist/index.js'))}`;
  const hud = tmux(['split-window', '-d', '-v', '-l', '7', '-t', main, '-P', '-F', '#{pane_id}', command]);
  const capture = () => tmux(['capture-pane', '-p', '-t', hud]);
  await until(() => capture().includes('Waiting for a Codex session'), 'renderer survives missing default sessions');
  const id = '019f3333-3333-7333-8333-333333333333';
  fs.mkdirSync(path.join(codexHome, 'shell_snapshots'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'shell_snapshots', `${id}.${BigInt(Date.now()) * 1000000n}.sh`), `export TMUX_PANE='${main}'\n`);
  const today = new Date();
  const date = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')];
  const file = writeRolloutFile(codexHome, { sessionId: id, relativeDir: date.join('/'), timestampLabel: `${date.join('-')}T00-00-00`, records: [canonicalSessionMeta({ id, cwd: root, timestamp: today.toISOString() }), taskStarted()] });
  await until(() => seen.includes(file), 'watcher detects first sessions directory and rollout');
  await until(() => {
    const value = tmux(['show-option', '-qv', '-t', 'first-use', '@codex_hud_bound']);
    try { return JSON.parse(Buffer.from(value, 'base64')).sessionId === id; } catch { return false; }
  }, 'renderer binds first rollout without restart');
  assert.equal(tmux(['display-message', '-p', '-t', main, '#{pane_pid}']), mainPid);
  assert.doesNotMatch(fs.existsSync(path.join(root, 'hud.log')) ? fs.readFileSync(path.join(root, 'hud.log'), 'utf8') : '', /sessions directory not found/);
  console.log('test-first-session-runtime: PASS (missing root, watcher, real binding, main pane preserved)');
} finally {
  await watcher?.stop();
  try { tmux(['kill-server']); } catch {}
  if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (oldSessions === undefined) delete process.env.CODEX_SESSIONS_PATH; else process.env.CODEX_SESSIONS_PATH = oldSessions;
  fs.rmSync(root, { recursive: true, force: true });
}
