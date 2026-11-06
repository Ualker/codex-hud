import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-binding-owner-'));
const socketDir = path.join(root, 'tmux');
fs.mkdirSync(socketDir);
const env = { ...process.env, TMUX_TMPDIR: socketDir, SHELL: '/bin/sh' };
delete env.TMUX;
delete env.TMUX_PANE;
const session = 'codex-hud-owner-test';
const tmux = (args) => execFileSync('tmux', args, { env, encoding: 'utf8', timeout: 10_000 }).trim();
const children = [];
const moduleUrl = new URL('../../dist/collectors/open-huds.js', import.meta.url).href;
async function publisher(bound = true) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { publishHudBinding } = await import(${JSON.stringify(moduleUrl)});
    await publishHudBinding(${JSON.stringify(session)}, ${bound ? "'same-codex-session'" : 'null'}, '/tmp/fixture.jsonl', '/work');
    process.stdout.write('ready');
    process.stdin.once('data', async () => {
      await publishHudBinding(${JSON.stringify(session)}, null, null, '/work');
      process.exit(0);
    });
    process.stdin.resume();
  `], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  child.done = new Promise((resolve) => child.once('exit', resolve));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('publisher did not become ready')), 12_000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); if (code !== 0) reject(new Error(`publisher exited ${code}`)); });
  });
  return child;
}
try {
  tmux(['-f', '/dev/null', 'new-session', '-d', '-s', session, 'exec sleep 60']);
  const pane = tmux(['display-message', '-p', '-t', session, '#{pane_id}']);
  tmux(['set-option', '-t', session, '@codex_hud_pane', pane]);
  const bindings = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { listOpenHudBindings } = await import(${JSON.stringify(moduleUrl)});
    console.log(JSON.stringify(await listOpenHudBindings()));
  `], { env, encoding: 'utf8', timeout: 12000 }));
  const first = await publisher();
  const firstValue = tmux(['show-option', '-qv', '-t', session, '@codex_hud_bound']);
  const second = await publisher();
  const secondValue = tmux(['show-option', '-qv', '-t', session, '@codex_hud_bound']);
  assert.notEqual(firstValue, secondValue, 'successive HUD processes have distinct ownership');
  first.stdin.write('shutdown');
  assert.equal(await first.done, 0);
  assert.equal(tmux(['show-option', '-qv', '-t', session, '@codex_hud_bound']), secondValue,
    'a late shutdown must not erase a newly started HUD binding');
  second.stdin.write('shutdown');
  assert.equal(await second.done, 0);
  assert.equal(tmux(['show-option', '-qv', '-t', session, '@codex_hud_bound']), '',
    'the current owner clears its own binding');

  const killed = await publisher();
  const saved = tmux(['show-option', '-qv', '-t', session, '@codex_hud_bound']);
  assert.equal(bindings().length, 1, 'a live publisher is discoverable');
  killed.kill('SIGKILL');
  await killed.done;
  assert.deepEqual(bindings(), [], 'a live pane does not keep a killed publisher alive');
  const unbound = await publisher(false);
  assert.equal(tmux(['show-option', '-qv', '-t', session, '@codex_hud_bound']), '', 'a fresh unbound HUD clears its dead predecessor');
  unbound.stdin.write('shutdown');
  await unbound.done;
  const stale = { ...JSON.parse(Buffer.from(saved, 'base64').toString()), ownerPid: process.pid, ownerStartedAt: 1 };
  tmux(['set-option', '-t', session, '@codex_hud_bound', Buffer.from(JSON.stringify(stale)).toString('base64')]);
  assert.deepEqual(bindings(), [], 'a reused live PID with a different birth time is not the old owner');
  console.log('test-hud-binding-owner: PASS');
} finally {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  try { tmux(['kill-server']); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
