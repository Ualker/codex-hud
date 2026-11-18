import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { executeSql } from '../helpers/sqlite.mjs';
import { canonicalSessionMeta, taskStarted, taskComplete, writeRolloutFile } from '../helpers/agent-rollout-fixture.mjs';

// Real HUD, SQLite and tmux, but a private socket and a sleeping fake Codex.
// No user pane or real model request is involved.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hc-')));
const home = path.join(root, 'home'), codexHome = path.join(home, '.codex');
const socket = path.join(root, 'tmux'), bin = path.join(root, 'bin');
for (const dir of [codexHome, socket, bin]) fs.mkdirSync(dir, { recursive: true });
fs.symlinkSync('/bin/sleep', path.join(bin, 'codex'));
const env = { ...process.env, HOME: home, TMUX_TMPDIR: socket, TERM: 'xterm-256color' };
for (const key of Object.keys(env)) if (/^(CODEX_HUD_|CMUX_)/.test(key) ||
  ['TMUX', 'TMUX_PANE', 'CODEX_HOME', 'CODEX_SESSIONS_PATH', 'XDG_STATE_HOME'].includes(key)) delete env[key];
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const tmux = args => execFileSync('tmux', args, { env, encoding: 'utf8', timeout: 8000 }).trim();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const oldId = '01a10000-0000-7000-8000-000000000011';
const newId = '01a10000-0000-7000-8000-000000000012';
const db = path.join(codexHome, 'logs_2.sqlite');
executeSql(db, `CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER,
  level TEXT, target TEXT, feedback_log_body TEXT, thread_id TEXT, process_uuid TEXT);`);
const sqlQuote = value => `'${String(value).replaceAll("'", "''")}'`;
let sequence = 0, nativePid, hud;
function log(request, id, pending = false, method = 'thread/start') {
  const now = Date.now();
  const body = `app_server.request{rpc.method="${method}" rpc.transport="in-process" rpc.request_id=${request} ` +
    'app_server.connection_id=0 app_server.client_name="codex-tui"}:' +
    (pending ? 'app_server.thread_start.notify_started{}: app-server event: thread/started targeted_connections=0' : 'shell_snapshot: created');
  executeSql(db, `INSERT INTO logs VALUES (${++sequence}, ${Math.floor(now / 1000)}, ${(now % 1000) * 1e6},
    'INFO', '${pending ? 'codex_app_server::outgoing_message' : 'codex_core::shell_snapshot'}',
    ${sqlQuote(body)}, ${id ? sqlQuote(id) : 'NULL'}, 'pid:${nativePid}:fixture');`);
}
function rollout(id, title, complete) {
  const now = new Date();
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')];
  return writeRolloutFile(codexHome, { sessionId: id, relativeDir: date.join('/'),
    timestampLabel: `${date.join('-')}T00-00-00`, records: [
      canonicalSessionMeta({ id, cwd: root, timestamp: now.toISOString() }),
      { timestamp: now.toISOString(), type: 'response_item', payload: { type: 'message', role: 'user',
        content: [{ type: 'input_text', text: title }] } },
      taskStarted({ timestamp: now.toISOString() }),
      ...(complete ? [taskComplete({ timestamp: now.toISOString() })] : []),
    ] });
}
const capture = () => tmux(['capture-pane', '-p', '-t', hud]);
const binding = () => {
  try { return JSON.parse(Buffer.from(tmux(['show-option', '-qv', '-t', 'clear-test', '@codex_hud_bound']), 'base64')); }
  catch { return {}; }
};
async function until(check, label, timeout = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (check()) return Date.now() - started; await delay(50); }
  assert.fail(`${label}\n${capture()}\n${fs.existsSync(path.join(root, 'hud.log')) ? fs.readFileSync(path.join(root, 'hud.log'), 'utf8') : ''}`);
}
try {
  const main = tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'clear-test', '-x', '150', '-y', '40',
    '-P', '-F', '#{pane_id}', `printf 'Ready · Full Access · Fast\n'; exec ${quote(path.join(bin, 'codex'))} 120`]);
  nativePid = tmux(['display-message', '-p', '-t', main, '#{pane_pid}']);
  const oldPath = rollout(oldId, 'PREVIOUS TASK TITLE', true);
  log(26, oldId);
  const command = `exec env CODEX_HUD_CWD=${quote(root)} CODEX_HUD_MAIN_PANE=${quote(main)} ` +
    `CODEX_HUD_TMUX_SESSION=clear-test CODEX_HUD_HEIGHT_FIT=0 CODEX_HUD_DETAILS=full ` +
    `CODEX_HUD_LOG_FILE=${quote(path.join(root, 'hud.log'))} ${quote(process.execPath)} ${quote(path.join(process.cwd(), 'dist/index.js'))}`;
  hud = tmux(['split-window', '-d', '-v', '-l', '12', '-t', main, '-P', '-F', '#{pane_id}', command]);
  tmux(['set-option', '-t', 'clear-test', '@codex_hud_main_pane', main]);
  tmux(['set-option', '-t', 'clear-test', '@codex_hud_pane', hud]);
  await until(() => binding().sessionId === oldId && /Idle/.test(capture()), 'initial completed task must bind');
  assert.match(capture(), /PREVIOUS TASK TITLE/);
  log(41, null, true);
  const latency = await until(() => binding().sessionId === null && binding().freshPrompt &&
    capture().includes('Session ready'), '/clear must reset without Context in the footer', 5000);
  assert.doesNotMatch(capture(), /PREVIOUS TASK TITLE|Turn:|Waiting for a Codex session/);
  log(26, oldId);
  // An append by the old writer must not restore old data through its watcher.
  fs.appendFileSync(oldPath, JSON.stringify(taskComplete()) + '\n');
  tmux(['send-keys', '-t', hud, 'C-t']);
  await until(() => /Ready/.test(capture()) && /\[me\]/.test(capture()), 'overview must show this pending pane as Ready');
  assert.doesNotMatch(capture(), /PREVIOUS TASK TITLE|Idle/);
  log(41, newId);
  await until(() => binding().sessionId === newId && /Ready/.test(capture()), 'real ID must replace pending identity');
  rollout(newId, 'CURRENT TASK TITLE', false);
  log(42, newId, false, 'turn/start');
  await until(() => /Thinking/.test(capture()), 'first message must resume normal overview activity');
  tmux(['send-keys', '-t', hud, 'C-t']);
  await until(() => /Thinking/.test(capture()) && /CURRENT TASK TITLE/.test(capture()), 'single view must follow the new rollout');
  assert.doesNotMatch(capture(), /PREVIOUS TASK TITLE|Session ready/);
  assert.equal(tmux(['display-message', '-p', '-t', main, '#{pane_pid}']), nativePid);
  console.log(`test-clear-session-runtime: PASS (custom footer, pending ID, old append, overview, first message; reset ${latency}ms)`);
} finally {
  try { tmux(['kill-server']); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
