import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-runtime-'));
const fixture = path.join(root, 'codex-hud');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(TMUX|CMUX_|CODEX_)/.test(key) && !['NO_COLOR', 'FORCE_COLOR'].includes(key)));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message) {
  const deadline = Date.now() + 15_000;
  do {
    if (predicate()) return;
    await pause();
  } while (Date.now() < deadline);
  assert.fail(message);
}
for (const dir of ['home', 'tmux', 'bin', 'codex-hud/src', 'codex-hud/dist', 'codex-hud/node_modules']) {
  fs.mkdirSync(path.join(root, dir), { recursive: true, mode: 0o700 });
}
fs.cpSync(path.join(repo, 'bin'), path.join(fixture, 'bin'), { recursive: true });
fs.copyFileSync(path.join(repo, 'package.json'), path.join(fixture, 'package.json'));
const recorder = `import fs from 'node:fs';
const names = ['CODEX_HOME', 'CODEX_SESSIONS_PATH', 'CODEX_HUD_DETAILS', 'NO_COLOR'];
fs.writeFileSync(process.env.HUD_TEST_ROOT + '/' + process.env.TMUX_PANE + '.json',
  JSON.stringify({pid: process.pid, ...Object.fromEntries(names.map(k => [k, process.env[k] ?? null]))}));
setInterval(() => {}, 1000);
`;
fs.writeFileSync(path.join(fixture, 'dist/index.js'), recorder);
fs.writeFileSync(path.join(root, 'main.mjs'), recorder);
fs.writeFileSync(path.join(root, 'bin/codex'),
  `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, 'main.mjs'))}\n`, { mode: 0o755 });
Object.assign(env, {
  HOME: path.join(root, 'home'), SHELL: '/bin/sh', TERM: 'xterm-256color',
  TMUX_TMPDIR: path.join(root, 'tmux'), HUD_TEST_ROOT: root,
  PATH: `${path.join(root, 'bin')}:${env.PATH}`,
  CODEX_HOME: path.join(root, 'server-home'), CODEX_SESSIONS_PATH: path.join(root, 'server-sessions'),
  CODEX_HUD_DETAILS: 'full', NO_COLOR: '1',
});
const tmux = (...args) => execFileSync('tmux', args, { env, encoding: 'utf8', timeout: 10_000 }).trim();
const option = (session, name) => tmux('show-option', '-t', session, '-qv', name);
const paneValue = (pane, format) => tmux('display-message', '-p', '-t', pane, format);
const readPane = (pane) => JSON.parse(fs.readFileSync(path.join(root, `${pane}.json`), 'utf8'));
const children = [];
async function launch(caller) {
  const prior = new Set(tmux('list-sessions', '-F', '#{session_name}').split('\n'));
  const child = spawn(path.join(fixture, 'bin/codex-hud'), ['--new-session'], {
    cwd: fixture, env: caller, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const done = new Promise((resolve) => child.on('close', resolve));
  let session;
  await until(() => {
    session = tmux('list-sessions', '-F', '#{session_name}').split('\n')
      .find((name) => !prior.has(name));
    return session;
  }, 'wrapper did not create a session');
  await until(() => {
    tmux('set-option', '-t', session, '@codex_hud_client_attached', '1');
    const hud = option(session, '@codex_hud_pane');
    const main = option(session, '@codex_hud_main_pane');
    return hud && main && [hud, main].every((pane) => fs.existsSync(path.join(root, `${pane}.json`)));
  }, 'fake Codex and HUD did not start');
  assert.notEqual(await done, 0, 'non-TTY attach should fail after creating live panes');
  assert.match(output, /not a terminal/, output);
  return { session, hud: option(session, '@codex_hud_pane'), main: option(session, '@codex_hud_main_pane') };
}

try {
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'unrelated', 'exec sleep 120');
  tmux('set-option', '-s', 'escape-time', '321');
  const unrelated = paneValue('unrelated', '#{pane_pid}');
  const caller = { ...env, CODEX_HOME: path.join(root, "caller home'one"),
    CODEX_SESSIONS_PATH: path.join(root, 'caller-sessions'), CODEX_HUD_BIND_TOGGLE: '0' };
  delete caller.CODEX_HUD_DETAILS;
  delete caller.NO_COLOR;
  const first = await launch(caller);
  for (const pane of [first.main, first.hud]) {
    assert.equal(readPane(pane).CODEX_HOME, caller.CODEX_HOME);
    assert.equal(readPane(pane).CODEX_SESSIONS_PATH, caller.CODEX_SESSIONS_PATH);
  }
  assert.equal(readPane(first.hud).CODEX_HUD_DETAILS, null);
  assert.equal(readPane(first.hud).NO_COLOR, null);
  assert.equal(tmux('show-options', '-sv', 'escape-time'), '321');

  const mainPid = paneValue(first.main, '#{pane_pid}');
  const oldHudPid = readPane(first.hud).pid;
  execFileSync(path.join(fixture, 'bin/codex-hud'), ['--reload', '--target', first.session], {
    cwd: fixture, env: { ...caller, CODEX_HOME: path.join(root, 'different-reload-home'),
      CODEX_SESSIONS_PATH: path.join(root, 'different-reload-sessions'), CODEX_HUD_DETAILS: 'full' },
    stdio: 'pipe', timeout: 15_000,
  });
  await until(() => readPane(first.hud).pid !== oldHudPid, 'reload did not replace the HUD');
  assert.equal(readPane(first.hud).CODEX_HOME, caller.CODEX_HOME, 'reload stays with the main Codex data root');
  assert.equal(readPane(first.hud).CODEX_SESSIONS_PATH, caller.CODEX_SESSIONS_PATH);
  assert.equal(readPane(first.hud).CODEX_HUD_DETAILS, 'full');
  assert.equal(paneValue(first.main, '#{pane_pid}'), mainPid);

  const noRoots = { ...caller };
  delete noRoots.CODEX_HOME;
  noRoots.CODEX_SESSIONS_PATH = '';
  const second = await launch(noRoots);
  for (const pane of [second.main, second.hud]) {
    assert.equal(readPane(pane).CODEX_HOME, null, 'unset roots do not inherit the server');
    assert.equal(readPane(pane).CODEX_SESSIONS_PATH, null, 'empty roots mean unset');
  }
  assert.equal(tmux('show-environment', '-g', 'CODEX_HOME'), `CODEX_HOME=${env.CODEX_HOME}`);

  // The real helper hooks run on the private server. Program resizes publish
  // their target first; manual ones must survive both hooks and keep focus.
  tmux('set-option', '-t', first.session, '@codex_hud_fit_height', '5');
  tmux('set-option', '-t', first.session, '@codex_hud_height', '5');
  tmux('resize-pane', '-t', first.hud, '-y', '5');
  await pause(150);
  tmux('select-pane', '-t', first.hud);
  tmux('resize-pane', '-t', first.hud, '-y', '9');
  await until(() => option(first.session, '@codex_hud_manual_height') === '9', 'manual resize was not recorded');
  assert.equal(paneValue(first.hud, '#{pane_height}'), '9');
  assert.equal(paneValue(first.hud, '#{pane_active}'), '1');

  tmux('resize-pane', '-t', first.hud, '-y', '5');
  await until(() => option(first.session, '@codex_hud_manual_height') === '5',
    'dragging back to the old program height must replace the manual override');
  tmux('set-hook', '-R', '-t', first.session, 'client-resized');
  assert.equal(paneValue(first.hud, '#{pane_height}'), '5');
  tmux('resize-pane', '-t', first.hud, '-y', '9');
  await until(() => option(first.session, '@codex_hud_manual_height') === '9', 'second drag was not recorded');
  tmux('set-hook', '-R', '-t', first.session, 'client-resized');
  assert.equal(paneValue(first.hud, '#{pane_height}'), '9');
  assert.equal(paneValue(first.hud, '#{pane_active}'), '1');

  const paneHeightModule = pathToFileURL(path.join(repo, 'dist/collectors/pane-height.js')).href;
  execFileSync(process.execPath, ['--input-type=module', '-e',
    `const {applyPaneHeight} = await import(${JSON.stringify(paneHeightModule)});
     if (!await applyPaneHeight(${JSON.stringify(first.session)}, ${JSON.stringify(first.hud)}, 7)) process.exit(1);`],
    { env, timeout: 10_000 });
  await pause(150);
  assert.equal(paneValue(first.hud, '#{pane_height}'), '7');
  assert.equal(option(first.session, '@codex_hud_manual_height'), '', 'changed content clears manual height');
  assert.equal(paneValue(first.hud, '#{pane_active}'), '1', 'content growth also preserves focus');
  assert.equal(paneValue(first.main, '#{pane_pid}'), mainPid);
  assert.equal(paneValue('unrelated', '#{pane_pid}'), unrelated);
  console.log('test-wrapper-runtime-isolation: PASS (roots, unset, reload, escape-time, manual height, focus)');
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  try { tmux('kill-server'); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
