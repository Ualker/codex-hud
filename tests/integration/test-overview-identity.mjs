import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OverviewCollector } from '../../dist/collectors/overview.js';
import { getCodexDataNamespace } from '../../dist/utils/codex-path.js';
import { canonicalSessionMeta, taskStarted, taskComplete, writeRolloutFile } from '../helpers/agent-rollout-fixture.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-overview-identity-'));
const originalEnv = { ...process.env };
try {
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const bindings = path.join(root, 'bindings'); fs.writeFileSync(bindings, '');
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\ncat "$HUD_TEST_BINDINGS"\n', { mode: 0o755 });
  Object.assign(process.env, { HOME: root, CODEX_HOME: root, CODEX_SESSIONS_PATH: '', HUD_TEST_BINDINGS: bindings, PATH: `${bin}:${process.env.PATH}` });
  const today = new Date();
  const date = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')];
  const create = (id, hour, source = 'cli', finished = false) => writeRolloutFile(root, {
    sessionId: id, relativeDir: date.join('/'), timestampLabel: `${date.join('-')}T${hour}-00-00`,
    records: [canonicalSessionMeta({ id, source }), finished ? taskComplete() : taskStarted(),
      { timestamp: today.toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'PRIVATE PROMPT TITLE' }] } }],
  });
  const id = '019f1111-1111-7111-8111-111111111111';
  const older = create(id, '00');
  const newer = create(id, '01', 'cli', true);
  let snapshot = await new OverviewCollector({ shared: false }).refresh();
  assert.equal(snapshot.sessions.length, 1, 'resumed session is one row');
  assert.equal(snapshot.sessions[0].turnActivity.phase, 'idle', 'newest rollout wins without a live binding');
  const binding = { namespace: getCodexDataNamespace(), tmuxSession: 'hud-main', sessionId: id, rolloutPath: older };
  const publish = () => fs.writeFileSync(bindings, `hud-main %2 0 %2 ${Buffer.from(JSON.stringify(binding)).toString('base64')}`);
  publish();
  snapshot = await new OverviewCollector({ shared: false }).refresh();
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].turnActivity.phase, 'thinking', 'live binding wins over another rollout');
  fs.unlinkSync(older);
  snapshot = await new OverviewCollector({ shared: false }).refresh();
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].unavailable, true, 'missing live rollout cannot resurrect an old state');
  fs.unlinkSync(newer); fs.writeFileSync(bindings, '');
  for (let i = 0; i < 25; i++) create(`019f2222-2222-7222-8222-${String(i).padStart(12, '0')}`, '00', { subagent: 'review' });
  let now = Date.now();
  const collector = new OverviewCollector({ shared: false, now: () => now });
  for (let i = 0; i < 10; i++) {
    now += 5001;
    assert.equal((await collector.refresh()).sessions.length, 0, 'subagents never become deferred or evicted ghost rows');
  }
  create(id, '02');
  process.env.CODEX_HUD_HIDE_TITLES = '1';
  snapshot = await new OverviewCollector().refresh();
  assert.equal(snapshot.sessions[0].title, undefined);
  const state = process.platform === 'darwin' ? path.join(root, 'Library/Application Support/codex-hud') : path.join(root, '.local/state/codex-hud');
  for (const file of fs.readdirSync(state)) assert.doesNotMatch(fs.readFileSync(path.join(state, file), 'utf8'), /PRIVATE PROMPT TITLE/);
  console.log('test-overview-identity: PASS (dedup, binding authority, 25 subagents, private snapshots)');
} finally {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  fs.rmSync(root, { recursive: true, force: true });
}
