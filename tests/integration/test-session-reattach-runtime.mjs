import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Real tmux, isolated from the user's server. Control-mode clients exercise
// attachment without needing a terminal or making real Codex requests.
const project = fileURLToPath(new URL('../..', import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ha-')));
const bin = path.join(root, 'bin');
const cwd = path.join(root, 'project');
const socketDir = path.join(root, 'tmux');
for (const dir of [bin, cwd, socketDir]) fs.mkdirSync(dir);
const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim();
const env = { ...process.env, TMUX_TMPDIR: socketDir, SHELL: '/bin/sh', TERM: 'xterm-256color' };
for (const key of Object.keys(env)) {
  if (/^(CODEX_HUD_|CMUX_)/.test(key) || key === 'TMUX' || key === 'TMUX_PANE') delete env[key];
}
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const tmux = (args) => execFileSync(realTmux, args, { env, encoding: 'utf8', timeout: 10_000 }).trim();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = [];
async function waitFor(check, message) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(25);
  }
  assert.fail(`${message}\n${children.map((child) => child.output).join('\n')}`);
}
for (const [name, script] of Object.entries({
  codex: 'exec sleep 120',
  npm: 'exit 0',
  node: `if [ "$1" = ${quote(path.join(project, 'dist/index.js'))} ]; then exec sleep 120; else exec ${quote(process.execPath)} "$@"; fi`,
  tput: 'case "$1" in lines) echo 24;; cols) echo 120;; *) echo 0;; esac',
  tmux: `if [ "$1" = attach-session ]; then
    [ -z "$ATTACH_DELAY" ] || sleep "$ATTACH_DELAY"
    [ "$ATTACH_FAIL" != 1 ] || exit 42
    exec ${quote(realTmux)} -C "$@"
  fi
  exec ${quote(realTmux)} "$@"`,
})) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
const launchEnv = { ...env, PATH: `${bin}:${env.PATH}`, CODEX_HUD_HEIGHT: '5', CODEX_HUD_HEIGHT_AUTO: '0' };
function track(child) {
  child.output = '';
  child.stdout.on('data', (data) => { child.output += data; });
  child.stderr.on('data', (data) => { child.output += data; });
  children.push(child);
  return child;
}
function launch(extraEnv = {}, args = []) {
  return track(spawn(path.join(project, 'bin/codex-hud'), args, { cwd, env: { ...launchEnv, ...extraEnv } }));
}
const sessions = () => tmux(['list-sessions', '-F', '#{session_name}']).split('\n');
const attached = (name) => Number(tmux(['list-sessions', '-F', '#{session_name}|#{session_attached}'])
  .split('\n').find((row) => row.startsWith(`${name}|`))?.split('|')[1]);
const hash = createHash('md5').update(cwd).digest('hex').slice(0, 8);
const prefix = `codex-hud-project-${hash}`;
const oldest = `codex-hud-${hash}-20260101000000-1`;
const second = `${prefix}-20260102000000-2`;
const newest = `${prefix}-20260103000000-3`;
const other = 'codex-hud-other-12345678-20260101000000-4';
const here = () => sessions().filter((name) => name.startsWith(`${prefix}-`) || name.startsWith(`codex-hud-${hash}-`));
async function detach(name) {
  tmux(['detach-client', '-s', `=${name}`]);
  await waitFor(() => attached(name) === 0, `${name} must detach`);
}
function seed(name) {
  const main = tmux(['new-session', '-d', '-s', name, '-P', '-F', '#{pane_id}', 'exec sleep 120']);
  tmux(['set-option', '-t', name, '@codex_hud_main_pane', main]);
  return tmux(['display-message', '-p', '-t', main, '#{pane_pid}']);
}

try {
  tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'bootstrap', 'exec sleep 120']);
  const originalPids = new Map([oldest, second, newest, other].map((name) => [name, seed(name)]));
  track(spawn(realTmux, ['-C', 'attach-session', '-t', newest], { env }));
  await waitFor(() => attached(newest) === 1, 'existing client must attach');

  launch();
  await waitFor(() => attached(oldest) === 1, 'plain codex must reuse the oldest detached session, including legacy names');
  assert.equal(attached(newest), 1, 'an attached session must not gain another client');
  assert.equal(here().length, 3, 'no new session while old detached sessions remain');
  launch();
  await waitFor(() => attached(second) === 1, 'the next launch must reuse the other detached session');
  launch();
  await waitFor(() => here().length === 4, 'only after both old sessions attach may a new one be created');
  const created = here().find((name) => ![oldest, second, newest].includes(name));
  await waitFor(() => attached(created) === 1, 'new session must attach');
  assert.equal(attached(other), 0, 'another project must remain detached');

  await detach(oldest);
  launch();
  await waitFor(() => attached(oldest) === 1, 'detaching again must make the same session reusable');
  assert.equal(here().length, 4);

  await detach(oldest);
  await detach(second);
  // Hold both clients between selection and attach, then start a third. The
  // third must wait, rather than treating reserved sessions as already attached.
  const concurrent = [launch({ ATTACH_DELAY: '1' })];
  await waitFor(() => tmux(['show-option', '-qv', '-t', oldest, '@codex_hud_attach_owner']) !== '', 'first launcher must reserve oldest');
  concurrent.push(launch({ ATTACH_DELAY: '1' }));
  await waitFor(() => tmux(['show-option', '-qv', '-t', second, '@codex_hud_attach_owner']) !== '', 'second launcher must reserve another session');
  concurrent.push(launch());
  await waitFor(() => {
    const rows = tmux(['list-sessions', '-F', '#{session_name}|#{session_attached}']).split('\n');
    const count = rows.filter((row) => row.startsWith(`${prefix}-`) || row.startsWith(`codex-hud-${hash}-`)).length;
    if (count > 4) {
      assert.ok(rows.includes(`${oldest}|1`) && rows.includes(`${second}|1`), 'a new session must never precede pending old attachments');
    }
    return count === 5;
  }, 'concurrent launches must consume both detached sessions before creating one more');
  await waitFor(() => here().every((name) => attached(name) === 1), 'every launch must get exactly one distinct session');
  assert.ok(concurrent.every((child) => child.exitCode === null), 'clients must stay attached');
  for (const name of here()) {
    assert.equal(tmux(['show-option', '-qv', '-t', name, '@codex_hud_attach_owner']), '',
      'successful attachment must release the reservation while its client is still connected');
  }

  await detach(oldest);
  const failed = spawnSync(path.join(project, 'bin/codex-hud'), [], {
    cwd, env: { ...launchEnv, ATTACH_FAIL: '1' }, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(failed.status, 42, 'attach failure must reach the caller');
  assert.equal(tmux(['show-option', '-qv', '-t', oldest, '@codex_hud_attach_owner']), '', 'failed attach must release its reservation');
  // Simulate a launcher killed before cleanup: a dead PID cannot strand a session.
  tmux(['set-option', '-t', oldest, '@codex_hud_attach_owner', '2147483647-1-1']);
  launch();
  await waitFor(() => attached(oldest) === 1, 'an abandoned reservation must be reclaimed');
  assert.equal(here().length, 5);

  for (const [name, pid] of originalPids) {
    const main = tmux(['show-option', '-qv', '-t', name, '@codex_hud_main_pane']);
    assert.equal(tmux(['display-message', '-p', '-t', main, '#{pane_pid}']), pid, 'reuse must preserve the existing main process');
  }
  console.log('test-session-reattach-runtime: PASS (oldest first, no duplicates, directory scope, concurrent launches, retry after failure, process preservation)');
} finally {
  for (const child of children) child.stdin.destroy();
  try { tmux(['kill-server']); } catch {}
  await Promise.all(children.map((child) => child.exitCode !== null ? undefined : new Promise((resolve) => child.once('exit', resolve))));
  fs.rmSync(root, { recursive: true, force: true });
}
