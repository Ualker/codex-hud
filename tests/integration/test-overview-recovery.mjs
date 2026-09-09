import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Exercise the real runtime, caches and shutdown with a fake tmux. Nothing
// contacts the user's server, sessions, config, or persistent state directory.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-overview-recovery-'));
const home = path.join(root, 'home');
const bin = path.join(root, 'bin');
const codexHome = path.join(home, '.codex');
fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
fs.mkdirSync(bin);
const bindings = path.join(root, 'bindings');
const failed = path.join(root, 'failed');
const log = path.join(root, 'tmux.log');
const rollout = path.join(root, 'good.jsonl');
const invalid = path.join(root, 'invalid.jsonl');
const now = new Date().toISOString();
fs.writeFileSync(rollout, [
  { timestamp: now, type: 'session_meta', payload: { id: 'good-session', cwd: '/work/healthy-project' } },
  { timestamp: now, type: 'event_msg', payload: { type: 'task_complete' } },
].map(JSON.stringify).join('\n') + '\n');
fs.writeFileSync(invalid, '{malformed\n');
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64');
fs.writeFileSync(bindings, [
  `codex-hud-good %2 0 %2 ${encode({ tmuxSession: 'codex-hud-good', sessionId: 'good-session', rolloutPath: rollout })}`,
  `codex-hud-broken %4 0 %4 ${encode({ tmuxSession: 'codex-hud-broken', sessionId: 'bad-session', rolloutPath: invalid, cwd: '/work/broken-project' })}`,
].join('\n'));
fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
case "$1" in
  list-panes)
    test ! -f "$HUD_TEST_FAILURE" || exit 1
    cat "$HUD_TEST_BINDINGS"
    ;;
  set-option) printf '%s\\n' "$*" >> "$HUD_TEST_LOG" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
const entry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const env = { ...process.env, HOME: home, CODEX_HOME: codexHome,
  CODEX_SESSIONS_PATH: path.join(codexHome, 'sessions'), CODEX_HUD_CWD: root,
  CODEX_HUD_MODE: 'overview', CODEX_HUD_TMUX_SESSION: 'codex-hud-fixture-owner',
  CODEX_HUD_LOG_FILE: path.join(root, 'hud.log'), PATH: `${bin}:${process.env.PATH}`,
  HUD_TEST_FAILURE: failed, HUD_TEST_BINDINGS: bindings, HUD_TEST_LOG: log,
  COLUMNS: '140', LINES: '6', NO_COLOR: '1' };
delete env.TMUX;
delete env.TMUX_PANE;
const child = spawn(process.execPath, [entry], { env, cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
let output = '';
let errors = '';
child.stdout.on('data', (data) => { output += data.toString(); });
child.stderr.on('data', (data) => { errors += data.toString(); });
const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label) {
  const started = Date.now();
  while (!predicate()) {
    if (child.exitCode !== null || child.signalCode) throw new Error(`HUD exited: ${errors}`);
    if (Date.now() - started > 20_000) throw new Error(`${label}: ${output}\n${errors}`);
    await delay(50);
  }
}
async function refresh() {
  output = '';
  child.kill('SIGUSR1'); // single
  await until(() => /Waiting for a Codex session/.test(output), 'switch to single');
  output = '';
  child.kill('SIGUSR1'); // overview, forced refresh
}
try {
  await until(() => /healthy-project/.test(output) && /broken-project/.test(output) && /Unknown/.test(output), 'initial rows');
  assert.match(output, /session log unavailable/);
  fs.writeFileSync(failed, '1');
  await refresh();
  await until(() => /session overview unavailable/.test(output), 'tmux failure');
  assert.match(output, /healthy-project/, 'failed refresh retains the last good snapshot');
  assert.doesNotMatch(output, /No active sessions/);

  fs.unlinkSync(failed);
  fs.writeFileSync(bindings, '');
  await refresh();
  await until(() => /No active sessions/.test(output), 'successful empty refresh');

  const writesBefore = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  child.kill('SIGTERM');
  const result = await exited;
  assert.equal(result.code, 0, errors);
  const writes = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  assert.equal(writes, writesBefore, 'an unbound HUD has no advertisement to clear');
  console.log('test-overview-recovery: PASS');
} finally {
  if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
  await exited;
  fs.rmSync(root, { recursive: true, force: true });
}
