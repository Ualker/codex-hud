import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../..', import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hud-cwd-')));
const fixture = path.join(root, 'codex-hud');
const projectA = path.join(root, 'project-a'), projectB = path.join(root, 'project b');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const dir of ['home', 'bin', 'tmux', 'project-a', 'project b', 'codex-hud/src', 'codex-hud/dist/utils', 'codex-hud/node_modules']) fs.mkdirSync(path.join(root, dir), { recursive: true });
fs.cpSync(path.join(source, 'bin'), path.join(fixture, 'bin'), { recursive: true });
fs.copyFileSync(path.join(source, 'package.json'), path.join(fixture, 'package.json'));
for (const file of ['namespace.js', 'utils/codex-path.js']) fs.copyFileSync(path.join(source, 'dist', file), path.join(fixture, 'dist', file));
fs.writeFileSync(path.join(fixture, 'dist/index.js'), `import fs from 'node:fs';
const report = {pid: process.pid, cwd: process.cwd(), hudCwd: process.env.CODEX_HUD_CWD, signals: 0};
const save = () => fs.writeFileSync(process.env.HUD_TEST_ROOT + '/hud.json', JSON.stringify(report));
for (const signal of ['SIGUSR1','SIGUSR2']) process.on(signal, () => {report.signals++; save();});
save(); setInterval(() => {}, 1000);
`);
// This CLI fixture independently applies the supported --cd forms, retaining
// argv so the test also catches wrappers that accidentally rewrite a prompt.
fs.writeFileSync(path.join(root, 'main.mjs'), `import fs from 'node:fs';
const args = process.argv.slice(2); let directory;
for(let i=0;i<args.length;i++) {
 if(args[i]==='--') break;
 if(['-c','--config'].includes(args[i])) {i++;continue;}
 if(['-C','--cd'].includes(args[i])) directory=args[++i];
 else if(args[i].startsWith('--cd=')) directory=args[i].slice(5);
 else if(args[i].startsWith('-C')) directory=args[i].slice(2).replace(/^=/,'');
}
if(directory) process.chdir(directory);
fs.writeFileSync(process.env.HUD_TEST_ROOT + '/main.json', JSON.stringify({pid:process.pid,cwd:process.cwd(),args}));
setInterval(() => {}, 1000);
`);
fs.writeFileSync(path.join(root, 'bin/codex'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, 'main.mjs'))} "$@"\n`, { mode: 0o755 });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TMUX|CMUX_|CODEX_|XDG_)/.test(key)));
Object.assign(env, { HOME: path.join(root, 'home'), SHELL: '/bin/sh', TERM: 'xterm-256color', TMUX_TMPDIR: path.join(root, 'tmux'),
  HUD_TEST_ROOT: root, PATH: path.join(root, 'bin') + path.delimiter + env.PATH, CODEX_HUD_BIND_TOGGLE: '0' });
const tmux = (...args) => execFileSync('tmux', args, { env, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const read = name => JSON.parse(fs.readFileSync(path.join(root, `${name}.json`)));
async function until(test, message) {
  for (let i = 0; i < 240; i++) { if (test()) return; await delay(50); }
  throw new Error(message);
}
const children = [];
try {
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'bootstrap', 'exec sleep 120');
  for (const args of [['--cd', '../project b'], [`--cd=${projectB}`], ['-C../project b'], ['-c', '--cd', '--', '-C', '../project b']]) {
    for (const name of ['main', 'hud']) fs.rmSync(path.join(root, `${name}.json`), { force: true });
    const child = spawn(path.join(fixture, 'bin/codex-hud'), ['--new-session', ...args], { cwd: projectA, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = '';
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    const closed = new Promise(resolve => child.once('close', resolve));
    let session;
    await until(() => { session = tmux('list-sessions', '-F', '#{session_name}').split('\n').find(name => name.startsWith('codex-hud-')); return session; }, 'session creation');
    await until(() => {
      tmux('set-option', '-t', session, '@codex_hud_client_attached', '1');
      return fs.existsSync(path.join(root, 'main.json')) && fs.existsSync(path.join(root, 'hud.json'));
    }, `wrapper startup: ${output}`);
    await closed; // A non-TTY attach may fail after both panes have launched.
    const expected = args.includes('--') ? projectA : projectB;
    assert.equal(read('main').cwd, expected, output);
    assert.equal(read('hud').hudCwd, expected);
    assert.equal(read('hud').cwd, expected);
    assert.equal(tmux('show-option', '-qv', '-t', session, '@codex_hud_cwd'), expected);
    assert.match(session, expected === projectA ? /^codex-hud-project-a-/ : /^codex-hud-project-b-/);
    assert.deepEqual(read('main').args, args, 'Codex argv retains its original relative paths and delimiters');
    const mainPane = tmux('show-option', '-qv', '-t', session, '@codex_hud_main_pane');
    const mainPid = tmux('display-message', '-p', '-t', mainPane, '#{pane_pid}');
    const control = command => {
      const result = spawnSync(path.join(fixture, 'bin/codex-hud'), [command, '--target', session], { cwd: fixture, env: { ...env, COLUMNS: '40' }, encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    };
    control('--toggle-mode');
    tmux('new-window', '-t', session, '-n', 'extra', 'exec sleep 120');
    control('--toggle-mode');
    control('--cycle-details');
    await until(() => read('hud').signals === 3, 'controls target the HUD in a non-current window');
    control('--reload');
    assert.equal(tmux('display-message', '-p', '-t', mainPane, '#{pane_pid}'), mainPid, 'controls and reload preserve the main process');
    tmux('kill-session', '-t', session);
  }
  console.log('test-wrapper-working-directory: PASS');
} finally {
  for (const child of children) if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
  try { tmux('kill-server'); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
