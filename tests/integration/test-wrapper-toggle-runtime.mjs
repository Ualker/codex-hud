import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../..', import.meta.url));
// macOS limits Unix socket paths to 104 bytes; its temp directory is long.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-'));
const bin = path.join(root, 'bin');
const socketDir = path.join(root, 'tmux');
fs.mkdirSync(bin);
fs.mkdirSync(socketDir);
const env = { ...process.env, TMUX_TMPDIR: socketDir, SHELL: '/bin/sh', TERM: 'xterm-256color' };
for (const key of Object.keys(env)) {
  if (/^(CODEX_HUD_|CMUX_)/.test(key) || key === 'TMUX' || key === 'TMUX_PANE') delete env[key];
}
const tmux = (args) => execFileSync('tmux', args, { env, encoding: 'utf8', timeout: 10_000 }).trim();
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, message) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await delay(25);
  }
  assert.fail(message);
}
const helper = path.join(root, 'reader.cjs');
fs.writeFileSync(helper, `
  const fs = require('node:fs');
  process.stdin.setRawMode(true);
  process.stdin.on('data', (data) => fs.appendFileSync(process.argv[2], data));
  fs.writeFileSync(process.argv[2] + '.ready', 'ready');
`);
const input = path.join(root, 'hud-input');
for (const [name, script] of Object.entries({
  codex: 'exec sleep 120',
  npm: 'exit 0',
  node: `if [ "$1" = ${quote(path.join(project, 'dist/index.js'))} ]; then exec ${quote(process.execPath)} ${quote(helper)} ${quote(input)}; else exec ${quote(process.execPath)} "$@"; fi`,
  tput: 'case "$1" in lines) echo 24;; cols) echo 120;; *) echo 0;; esac',
})) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });

try {
  tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'bootstrap', 'exec sleep 120']);
  const started = spawnSync(path.join(project, 'bin/codex-hud'), ['--new-session'], {
    cwd: project,
    env: { ...env, PATH: `${bin}:${env.PATH}`, CODEX_HUD_HEIGHT: '5', CODEX_HUD_HEIGHT_AUTO: '0' },
    encoding: 'utf8', timeout: 20_000,
  });
  // The wrapper creates the session before its expected non-TTY attach failure.
  assert.match(started.stdout + started.stderr, /open terminal failed: not a terminal/);
  const session = tmux(['list-sessions', '-F', '#{session_name}']).split('\n')
    .find((name) => name.startsWith('codex-hud-'));
  assert.ok(session, 'the wrapper must create a HUD session');
  const main = tmux(['show-option', '-qv', '-t', session, '@codex_hud_main_pane']);
  await waitFor(() => fs.existsSync(`${input}.ready`), 'HUD input reader must start');

  // Execute the installed key's command through tmux's own parser, with the
  // same source-pane context as pressing Prefix+H. Merely checking that a
  // binding exists misses invalid commands inside if-shell's true branch.
  const binding = tmux(['list-keys', '-T', 'prefix']).split('\n')
    .find((line) => /^bind-key\s+-T\s+prefix\s+H\s/.test(line));
  assert.ok(binding, 'the wrapper must install Prefix+H');
  const commandFile = path.join(root, 'toggle.conf');
  const command = binding.replace(/^bind-key\s+-T\s+prefix\s+H\s+/, '');
  assert.match(command, /^run-shell\s/, 'the binding must retain its format-expansion layer');
  const executeBinding = (pane) => {
    // tmux 3.2a has no source-file -t. run-shell -t supplies the same pane
    // context while still exercising the installed command's nested parser.
    fs.writeFileSync(commandFile, command.replace(/^run-shell\s+/, `run-shell -t ${quote(pane)} `) + '\n');
    tmux(['source-file', commandFile]);
  };
  executeBinding(main);
  await waitFor(() => fs.existsSync(input), 'Prefix+H must send Ctrl+T to the HUD pane');
  assert.deepEqual(fs.readFileSync(input), Buffer.from([0x14]));
  assert.equal(tmux(['display-message', '-p', '-t', session, '#{pane_id}']), main,
    'toggling must keep focus in the main pane');

  const otherInput = path.join(root, 'other-input');
  const other = tmux(['new-session', '-d', '-s', 'without-hud', '-P', '-F', '#{pane_id}',
    `exec ${quote(process.execPath)} ${quote(helper)} ${quote(otherInput)}`]);
  await waitFor(() => fs.existsSync(`${otherInput}.ready`), 'unrelated pane must start');
  executeBinding(other);
  await delay(100);
  assert.equal(fs.existsSync(otherInput), false, 'a session without a HUD must receive no keys');
  assert.deepEqual(fs.readFileSync(input), Buffer.from([0x14]),
    'a different session must not toggle this HUD');
  console.log('test-wrapper-toggle-runtime: PASS (Ctrl+T delivered, focus preserved, other session untouched)');
} finally {
  try { tmux(['kill-server']); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
