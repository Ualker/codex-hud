import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionFinder } from '../../dist/collectors/session-finder.js';
import { executeSql } from '../helpers/sqlite.mjs';

// Codex 0.170: /clear starts a thread before its first rollout exists. Its
// old thread can log teardown a minute later. Neither mtime nor persistence
// rank identifies the thread currently selected by this TUI.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-lifecycle-'));
const saved = { ...process.env };
const oldId = '01a10000-0000-7000-8000-000000000001';
const newId = '01a10000-0000-7000-8000-000000000002';
const home = path.join(root, 'codex');
const cwd = path.join(root, 'project');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(cwd);
process.env.CODEX_HOME = home;
process.env.CODEX_HUD_MAIN_PANE = '%1';
process.env.HOME = root;
process.env.XDG_STATE_HOME = path.join(root, 'state');
delete process.env.CODEX_SESSIONS_PATH;
const db = path.join(home, 'logs_2.sqlite');
executeSql(db, `CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER,
  level TEXT, target TEXT, feedback_log_body TEXT, thread_id TEXT, process_uuid TEXT);`);
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
let sequence = 0;
function log(request, threadId, { method = 'thread/start', client = 'codex-tui',
  pid = process.pid, connection = 0, target = 'codex_core::shell_snapshot', notification = false } = {}) {
  const ms = Date.now() + sequence++;
  const body = `app_server.request{rpc.method="${method}" rpc.transport="in-process" ` +
    `rpc.request_id=${request} app_server.connection_id=${connection} app_server.client_name="${client}"}:` +
    (notification ? 'app_server.thread_start.notify_started{}: app-server event: thread/started targeted_connections=0' : 'handled');
  executeSql(db, `INSERT INTO logs VALUES (${sequence}, ${Math.floor(ms / 1000)}, ${(ms % 1000) * 1e6},
    'INFO', ${quote(target)}, ${quote(body)}, ${threadId ? quote(threadId) : 'NULL'}, ${quote(`pid:${pid}:fixture`)});`);
  return ms;
}
function turnOutput(threadId, startedAt) {
  const stamp = Math.trunc(startedAt).toString(16).padStart(12, '0');
  const turnId = `${stamp.slice(0, 8)}-${stamp.slice(8)}-7000-8000-000000000001`;
  const body = `session_loop{thread_id=${threadId}}:submission_dispatch{codex.op="turn_input"}:` +
    `codex.turn_input{conversation.id=${threadId} turn.id="${turnId}"}:turn{}: output`;
  const ms = Math.max(Date.now() + sequence++, startedAt + 1);
  executeSql(db, `INSERT INTO logs VALUES (${sequence}, ${Math.floor(ms / 1000)}, ${(ms % 1000) * 1e6},
    'INFO', 'codex_core::session::world_state', ${quote(body)}, ${quote(threadId)}, ${quote(`pid:${process.pid}:fixture`)});`);
}
function rollout(id) {
  const now = new Date();
  const dir = path.join(home, 'sessions', String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-11-18T16-27-21-${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', timestamp: now.toISOString(),
    payload: { id, cwd, source: 'cli', originator: 'codex-tui' } }) + '\n');
  return fs.realpathSync(file);
}
const changes = [];
function finder() {
  const value = new SessionFinder(cwd, session => changes.push(session?.sessionId ?? null), new Date());
  // Only OS ownership discovery is faked. Ledger SQL, ordering, metadata,
  // binding callbacks and rollout discovery use the real implementation.
  value.getPanePid = async () => String(process.pid);
  value.getProcessTree = async () => ({ processIds: [String(process.pid)],
    commands: ['/usr/local/bin/codex'], codexPids: [String(process.pid)],
    tuiPids: [String(process.pid)], daemonPids: [] });
  return value;
}
try {
  const oldPath = rollout(oldId);
  log(26, oldId);
  const live = finder();
  assert.equal((await live.check(true))?.path, oldPath);
  log(41, null, { target: 'codex_app_server::outgoing_message', notification: true });
  log(41, newId);
  // Delayed output on an old request must not move the UI backwards.
  log(26, oldId);
  assert.equal((await live.check(true))?.sessionId, newId,
    'a successful /clear selects the new log-backed thread over the old persisted rollout');
  assert.equal((await finder().check(true))?.sessionId, newId,
    'a cold HUD must recover the same selection from request order');

  // No lifecycle event on task completion, /status or Ctrl+L: normal polling
  // must retain the completed task, even with a plain "Ready" TUI footer.
  const stableChanges = changes.length;
  await live.check(true);
  assert.equal(changes.length, stableChanges);
  const success = { notification: true, target: 'codex_app_server::outgoing_message' };
  log(42, null); // request begun is not a successful creation
  log(42, null, { notification: true }); // same words in an unrelated log target
  log(42, null, { ...success, method: 'thread/read' });
  log(90, null, { ...success, pid: process.pid + 100000 }); // another pane in this cwd
  log(90, null, { ...success, client: 'vscode', connection: 1 });
  assert.equal((await live.check(true))?.sessionId, newId);
  assert.equal(live.isAwaitingSessionId(), false);

  // Exercise the incremental path while full resolution is deeply idle.
  live.setDeepIdle(true);
  live.lastFullResolveAt = Date.now();
  live.fullResolveIntervalMs = 60000;
  live.getProcessTree = async () => { throw new Error('fast polling must not rescan processes'); };
  log(43, null, success);
  assert.equal(await live.check(), null);
  assert.equal(live.isAwaitingSessionId(), true);
  assert.equal(live.getPreviousSessionId(), newId);
  const pendingChanges = changes.length;
  log(41, newId); // late snapshot from before clear
  await live.check();
  assert.equal(changes.length, pendingChanges, 'old events cannot undo or repeat a clear');
  assert.equal((await finder().check(true)), null, 'cold reload retains a pending successful start');
  log(44, null, success);
  await live.check();
  assert.equal(changes.length, pendingChanges + 2, 'two consecutive clears have distinct generations (plus cold binding)');
  log(43, newId); // ID for the skipped intermediate session
  assert.equal(await live.check(), null);
  const thirdId = '01a10000-0000-7000-8000-000000000003';
  const thirdPath = rollout(thirdId);
  log(44, thirdId);
  log(45, thirdId, { method: 'turn/start' }); // user typed immediately after /clear
  assert.equal((await live.check())?.path, thirdPath);
  assert.equal(live.isAwaitingSessionId(), false);
  log(44, null, success); // delayed notification cannot wipe an already-known thread
  assert.equal((await live.check())?.sessionId, thirdId);
  log(46, oldId, { method: 'thread/resume' });
  assert.equal((await live.check())?.path, oldPath, '/resume can intentionally return to an older ID');
  const sideId = '01a10000-0000-7000-8000-000000000004';
  log(47, sideId, { method: 'thread/fork' });
  log(48, sideId, { method: 'turn/start' });
  assert.equal((await live.check())?.sessionId, oldId, 'a transient side conversation cannot steal the main pane');

  const clearedAt = log(50, thirdId);
  turnOutput(oldId, clearedAt - 60000);
  assert.equal((await live.check())?.sessionId, thirdId,
    'late output of a turn begun before /clear cannot replace the fresh thread');
  // Real 0.170 incident: 1000-row pruning removed the resume and turn/start
  // requests, but current user-turn spans still identify the resumed root.
  turnOutput(oldId, clearedAt + 1);
  assert.equal((await live.check())?.sessionId, oldId, 'a newer root user turn recovers a pruned resume request');
  assert.equal((await finder().check(true))?.sessionId, oldId, 'cold reload recovers the active root, not an old empty start');
  const pendingAt = log(51, null, success);
  turnOutput(oldId, clearedAt + 1);
  turnOutput(sideId, pendingAt + 1);
  assert.equal(await live.check(), null,
    'after another clear, late old output and newer /side output both leave the fresh prompt intact');
} finally {
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
  Object.assign(process.env, saved);
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('Session lifecycle binding tests passed');
