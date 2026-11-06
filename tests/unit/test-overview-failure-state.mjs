import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OverviewCollector } from '../../dist/collectors/overview.js';
import { getCodexDataNamespace } from '../../dist/utils/codex-path.js';
import { needsAttention } from '../../dist/ui/state.js';
import { renderOverviewLayout } from '../../dist/render/overview.js';
import { stripAnsi } from '../../dist/render/colors.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-overview-failure-'));
const oldEnv = { ...process.env };
try {
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'));
  Object.assign(process.env, { CODEX_HOME: home, CODEX_SESSIONS_PATH: path.join(home, 'sessions'),
    PATH: `${path.join(root, 'bin')}:${process.env.PATH}` });
  const file = path.join(root, 'rollout.jsonl');
  let now = Date.now();
  const record = (type, payload) => JSON.stringify({ timestamp: new Date(now).toISOString(), type, payload });
  fs.writeFileSync(file, [record('session_meta', { id: 'fixture', cwd: root }),
    record('event_msg', { type: 'task_complete', turn_id: 'one' })].join('\n') + '\n');
  const binding = Buffer.from(JSON.stringify({ namespace: getCodexDataNamespace(), tmuxSession: 'hud-test',
    sessionId: 'fixture', rolloutPath: file, cwd: root })).toString('base64');
  fs.writeFileSync(path.join(root, 'bin/tmux'), `#!/bin/sh\nprintf '%s\\n' 'hud-test %2 0 %2 ${binding}'\n`, { mode: 0o755 });
  const collector = new OverviewCollector({ shared: false, now: () => now });
  assert.equal((await collector.refresh()).sessions[0].unavailable, false);
  // EISDIR also fails for root, unlike chmod-based permission fixtures.
  fs.renameSync(file, `${file}.saved`);
  fs.mkdirSync(file);
  now += 30001;
  assert.equal((await collector.refresh()).sessions[0].unavailable, true);
  now += 1000;
  const failed = (await collector.refresh()).sessions[0];
  assert.equal(collector.getDiagnostics().parsedLastRefresh, 0, 'this refresh did not retry the file');
  assert.equal(failed.unavailable, true, 'a skipped read cannot clear a failure');
  assert.equal(needsAttention(failed), true);
  now += 5000;
  assert.equal((await collector.refresh()).sessions[0].unavailable, true, 'failed rows retry promptly');
  assert.equal(collector.getDiagnostics().parsedLastRefresh, 1);
  fs.rmdirSync(file);
  fs.renameSync(`${file}.saved`, file);
  now += 5001;
  assert.equal((await collector.refresh()).sessions[0].unavailable, false, 'successful reading clears the failure');

  const layout = { mode: 'expanded', showSeparators: false, showDuration: true, showContextBreakdown: true, barWidth: 8 };
  const base = { rateLimits: { primary: { used_percent: 100, window_minutes: 300, resets_at: Date.now() / 1000 + 3600 } },
    collectorHealth: { overview: { status: 'error', lastAttemptAt: new Date() } },
    overview: { namespace: 'test', updatedAt: new Date(), sessions: [{ id: 'one', projectName: 'Idle project' }] } };
  for (const sessions of [base.overview.sessions, []]) {
    const lines = renderOverviewLayout({ ...base, overviewFilter: 'attention', overview: { ...base.overview, sessions } }, layout, 100, 5).map(stripAnsi).join('\n');
    assert.match(lines, /0% left/, 'quota exhaustion survives empty lists and filters');
    assert.match(lines, /session overview unavailable/, 'global errors survive empty lists and filters');
  }
  console.log('test-overview-failure-state: PASS');
} finally {
  for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
  Object.assign(process.env, oldEnv);
  fs.rmSync(root, { recursive: true, force: true });
}
