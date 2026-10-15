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
  const homeA=path.join(root,'account-a'),homeB=path.join(root,'account-b');
  fs.mkdirSync(homeA);fs.mkdirSync(homeB);
  tmux(['-f','/dev/null','new-session','-d','-s','bootstrap','exec sleep 55']);
  seed(oldest);
  tmux(['set-environment','-t',oldest,'CODEX_HOME',homeA]);
  tmux(['set-environment','-t',oldest,'CODEX_SESSIONS_PATH',path.join(homeA,'sessions')]);
  const mainPid = tmux(['display-message', '-p', '-t', oldest, '#{pane_pid}']);
  launch({CODEX_HOME:homeB,CODEX_SESSIONS_PATH:path.join(homeB,'sessions')});
  await waitFor(()=>here().length === 2, 'a foreign namespace must create its own session');
  const own = here().find(name => name !== oldest);
  await waitFor(()=>attached(own) === 1, 'new namespace session attaches');
  assert.equal(attached(oldest), 0, 'foreign account remains detached');
  assert.equal(tmux(['display-message', '-p', '-t', oldest, '#{pane_pid}']), mainPid);
  await detach(own);
  const linked = path.join(root, 'account-link');
  fs.symlinkSync(homeB, linked);
  launch({CODEX_HOME:linked,CODEX_SESSIONS_PATH:path.join(linked,'sessions')});
  await waitFor(()=>attached(own) === 1, 'a symlink alias of the same namespace reattaches');
  assert.equal(here().length, 2);
  console.log('test-session-namespace-runtime: PASS (foreign account isolated, canonical alias reattached, main process preserved)');

} finally {
  try {tmux(['kill-server']);} catch {}
  for(const child of children){if(child.exitCode===null)child.kill('SIGTERM');}
  await delay(200);
  fs.rmSync(root,{recursive:true,force:true});
}
