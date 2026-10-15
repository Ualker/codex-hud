import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OverviewCollector } from '../../dist/collectors/overview.js';
import { getCodexDataNamespace } from '../../dist/utils/codex-path.js';
import { canonicalSessionMeta, taskStarted, taskComplete } from '../helpers/agent-rollout-fixture.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-overview-budget-'));
const oldEnv = { ...process.env };
try {
  const home = path.join(root, 'account');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  Object.assign(process.env, { CODEX_HOME: home, CODEX_SESSIONS_PATH: path.join(home, 'sessions'), PATH: `${bin}:${process.env.PATH}` });
  const namespace = getCodexDataNamespace();
  const bindings = path.join(root, 'bindings');
  process.env.HUD_TEST_BINDINGS = bindings;
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\ncat "$HUD_TEST_BINDINGS"\n', { mode: 0o755 });
  const encode = records => records.map(JSON.stringify).join('\n') + '\n';
  const rows = [];
  const add = (id, scope = namespace) => {
    const file = path.join(root, `${id}.jsonl`);
    fs.writeFileSync(file, encode([canonicalSessionMeta({ id }), taskStarted()]));
    const payload = { namespace: scope, tmuxSession: `hud-${id}`, sessionId: id, rolloutPath: file };
    rows.push(`hud-${id} %2 0 %2 ${Buffer.from(JSON.stringify(payload)).toString('base64')}`);
    fs.writeFileSync(bindings, rows.join('\n'));
    return file;
  };
  const file = add('backlog');
  add('foreign', 'other-account');
  let now = Date.now();
  const collector = new OverviewCollector({ shared: false, now: () => now });
  assert.deepEqual((await collector.refresh(['backlog'])).sessions.map(row => row.id), ['backlog']);
  const filler = encode([{ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'reasoning', content: 'x'.repeat(1024) } }]);
  fs.appendFileSync(file, filler.repeat(Math.ceil(4.5 * 1024 * 1024 / filler.length)) + encode([taskComplete()]));
  now += 5001;
  const behind = await collector.refresh(['backlog']);
  assert.equal(behind.sessions[0].refreshing, true);
  now++;
  const caughtUp = await collector.refresh(['backlog']);
  assert.equal(caughtUp.sessions[0].turnActivity.phase, 'idle', 'sub-MiB backlog drains without another append');
  assert.equal(caughtUp.sessions[0].refreshing, false);

  for (let i = 0; i < 31; i++) add(`session-${i}`);
  const observed = new Set();
  for (let i = 0; i < 8; i++) {
    now += 5001;
    const snapshot = await collector.refresh(['backlog', 'session-30']);
    assert.equal(snapshot.sessions.length, 32, 'deferred rows retain identity');
    snapshot.sessions.filter(row => row.turnActivity).forEach(row => observed.add(row.id));
    assert.ok(collector.getDiagnostics().parserCount <= 20);
    assert.ok(collector.getDiagnostics().parsedLastRefresh <= 8);
  }
  assert.equal(observed.size, 32, 'background sessions must not starve behind priority rows');
  console.log('test-overview-budget-and-namespace: PASS');
} finally {
  for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
  Object.assign(process.env, oldEnv);
  fs.rmSync(root, { recursive: true, force: true });
}
