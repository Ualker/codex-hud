import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hud-approval-cwd-')));
const repo = process.cwd();
const home = path.join(root, 'home'), codexHome = path.join(home, '.codex');
const projectA = path.join(root, 'project-a'), projectB = path.join(root, 'worktree-b');
const id = '019fffff-6666-7000-8000-666666666666';
const now = Date.now(), at = new Date(now - 20000).toISOString();
const directory = path.join(codexHome, 'sessions', ...new Date().toISOString().slice(0, 10).split('-'));
fs.mkdirSync(directory, { recursive: true });
fs.mkdirSync(path.join(codexHome, 'shell_snapshots'));
fs.mkdirSync(path.join(root, 'bin'));
for (const [cwd, branch] of [[projectA, 'fixture-a'], [projectB, 'fixture-b']]) {
  fs.mkdirSync(cwd);
  execFileSync('git', ['init', '-q', '-b', branch, cwd], { stdio: 'pipe' });
}
const file = path.join(directory, `rollout-${new Date().toISOString().slice(0, 10)}T00-00-00-${id}.jsonl`);
const record = (type, payload) => JSON.stringify({ timestamp: at, type, payload }) + '\n';
fs.writeFileSync(file, record('session_meta', { id, cwd: projectA, timestamp: at })
  + record('event_msg', { type: 'task_complete', turn_id: 'old' }));
fs.writeFileSync(path.join(codexHome, 'shell_snapshots', `${id}.${BigInt(now) * 1000000n}.sh`), "export TMUX_PANE='%999999'\n");
const screen = path.join(root, 'screen'), events = path.join(root, 'events'), tmuxLog = path.join(root, 'tmux.log');
fs.writeFileSync(screen, '');
fs.writeFileSync(path.join(root, 'bin/tmux'), '#!/bin/sh\nif [ "$1" = set-option ]; then printf "%s\\n" "$*" >> "$HUD_TEST_TMUX_LOG"; else exit 1; fi\n', { mode: 0o755 });
const preload = path.join(root, 'pane-fixture.mjs');
fs.writeFileSync(preload, `
  import fs from 'node:fs';
  import { ApprovalDetector } from ${JSON.stringify(pathToFileURL(path.join(repo, 'dist/collectors/approval-detector.js')).href)};
  import { CodexLivenessProbe } from ${JSON.stringify(pathToFileURL(path.join(repo, 'dist/collectors/codex-liveness.js')).href)};
  // Only the terminal transport and its liveness are fixtures. The parser,
  // detector identity, main notification wiring and notification hook run normally.
  const refresh = ApprovalDetector.prototype.refresh;
  ApprovalDetector.prototype.refresh = function(...args) {
    this.stallMs = 0; this.probeIntervalMs = 0;
    this.capturePane = async () => fs.readFileSync(${JSON.stringify(screen)}, 'utf8');
    return refresh.apply(this, args);
  };
  CodexLivenessProbe.prototype.refresh = async () => false;
`);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CODEX_|CMUX_|TMUX|NODE_OPTIONS|XDG_)/.test(key)));
Object.assign(env, { HOME: home, CODEX_HOME: codexHome, CODEX_HUD_CWD: projectA, CODEX_HUD_MAIN_PANE: '%999999',
  CODEX_HUD_TMUX_SESSION: 'hud-fixture', CODEX_HUD_HEIGHT_FIT: '0', CODEX_HUD_LOG_FILE: path.join(root, 'hud.log'),
  CODEX_HUD_NOTIFY_CMD: `{ cat; printf '\\n'; } >> ${quote(events)}`, HUD_TEST_TMUX_LOG: tmuxLog,
  PATH: path.join(root, 'bin') + path.delimiter + env.PATH, COLUMNS: '160', LINES: '8', NO_COLOR: '1' });
const child = spawn(process.execPath, ['--import', preload, path.join(repo, 'dist/index.js')], { cwd: projectA, env, stdio: ['pipe', 'pipe', 'pipe'] });
let output = '', errors = '';
child.stdout.on('data', chunk => output = (output + chunk).slice(-100000));
child.stderr.on('data', chunk => errors += chunk);
const closed = new Promise(resolve => child.once('close', resolve));
const notifications = () => fs.existsSync(events) ? fs.readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label) {
  for (let i = 0; i < 240; i++) {
    if (test()) return;
    if (child.exitCode !== null) break;
    await delay(50);
  }
  throw new Error(`${label}; stderr=${errors}; output=${output.slice(-1500)}`);
}
const prompt = choice => `Would you like to run the following command?\n  $ echo fixture\n${choice}1. Yes, proceed\n  2. No, continue without running it\nEnter to confirm   Esc to cancel`;
try {
  await until(() => output.includes('Idle') && output.includes('fixture-a'), 'initial project and Git state');
  assert.equal(notifications().length, 0);
  fs.writeFileSync(screen, prompt('> '));
  fs.appendFileSync(file, record('turn_context', { cwd: projectB, approval_policy: 'on-request' })
    + record('event_msg', { type: 'task_started', turn_id: 'same-turn' })
    + record('response_item', { type: 'function_call', name: 'exec_command', call_id: 'approval-one', arguments: '{"cmd":"echo fixture"}' }));
  await until(() => notifications().length === 1 && output.includes('fixture-b'), 'first approval and runtime worktree switch');
  fs.writeFileSync(screen, prompt('  '));
  await delay(1200);
  assert.equal(notifications().length, 1, 'moving a choice cursor does not make a new approval');
  fs.appendFileSync(file, record('response_item', { type: 'function_call_output', call_id: 'approval-one', output: 'Process exited with code 0' })
    + record('response_item', { type: 'function_call', name: 'exec_command', call_id: 'approval-two', arguments: '{"cmd":"echo fixture"}' }));
  await until(() => notifications().length === 2, 'a second call in the same turn notifies before cooldown expires');
  assert.deepEqual(notifications().map(event => event.event), ['approval-needed', 'approval-needed']);
  assert.ok(notifications().every(event => event.cwd === projectB), 'notification cwd follows validated runtime state');
  assert.ok(fs.readFileSync(tmuxLog, 'utf8').includes(`@codex_hud_cwd ${projectB}`), 'reload metadata follows the runtime directory');
  fs.appendFileSync(file, record('turn_context', { approval_policy: 'never' })
    + record('response_item', { type: 'function_call_output', call_id: 'approval-two', output: 'Process exited with code 0' })
    + record('response_item', { type: 'function_call', name: 'exec_command', call_id: 'automatic', arguments: '{"cmd":"true"}' }));
  await delay(1500);
  assert.equal(notifications().length, 2, 'automatic approval never notifies');
  console.log('test-approval-and-cwd-runtime: PASS');
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  await closed;
  clearTimeout(timer);
  fs.rmSync(root, { recursive: true, force: true });
}
