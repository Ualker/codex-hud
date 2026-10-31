import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RolloutParser } from '../../dist/collectors/rollout.js';
import { ApprovalDetector } from '../../dist/collectors/approval-detector.js';
import { SessionFinder } from '../../dist/collectors/session-finder.js';
import { HudNotifier, rateLimitNotificationScope } from '../../dist/notify.js';
import { selectedSession } from '../../dist/ui/state.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-state-boundaries-'));
const now = Date.now();
const record = (type, payload) => JSON.stringify({ timestamp: new Date(now - 20000).toISOString(), type, payload }) + '\n';
try {
  const file = path.join(root, 'rollout-2026-10-31T00-00-00-019fffff-0000-7000-8000-000000000001.jsonl');
  let log = record('session_meta', { id: 'approval-thread', cwd: root })
    + record('event_msg', { type: 'task_started', turn_id: 'approval-turn' })
    + record('response_item', { type: 'function_call', name: 'exec_command', call_id: 'pending', arguments: '{"cmd":"sleep 100"}' });
  for (let i = 0; i < 11; i++) log +=
    record('response_item', { type: 'function_call', name: 'exec_command', call_id: `done-${i}`, arguments: '{"cmd":"true"}' })
    + record('response_item', { type: 'function_call_output', call_id: `done-${i}`, output: 'Process exited with code 0' });
  fs.writeFileSync(file, log);
  const parser = new RolloutParser(10);
  parser.setRolloutPath(file);
  const data = await parser.parse();
  assert.equal(data.toolActivity.recentCalls.some(call => call.id === 'pending'), false);
  assert.deepEqual(data.toolActivity.runningCalls.map(call => call.id), ['pending']);
  let captures = 0;
  const detector = new ApprovalDetector({ mainPane: '%99', capturePane: async () => {
    captures++;
    return 'Would you like to run the following command?\n> 1. Yes, proceed\n  2. No, continue without running it\nEnter to confirm   Esc to cancel';
  } });
  const input = { turnActivity: data.turnActivity, toolActivity: data.toolActivity,
    lastEventAt: data.lastEventTime, approvalPolicy: 'on-request' };
  await detector.refresh(input, now);
  assert.equal(detector.isApprovalNeeded(), true, 'a pending call outside recent history still detects approval');
  detector.reset();
  await detector.refresh({ ...input, approvalPolicy: 'never' }, now + 20000);
  assert.equal(captures, 1, 'automatic approval does not capture or notify');

  const finder = new SessionFinder(root);
  finder.currentThreadId = '019fffff-0000-7000-8000-000000000001';
  finder.currentSession = { path: file, sessionId: finder.currentThreadId };
  let checks = 0;
  finder.check = async () => { checks++; return finder.currentSession; };
  for (let i = 0; i < 20; i++) await finder.noteRolloutAppeared(file);
  assert.equal(checks, 0, 'bound appends do not force process/SQLite resolution');
  finder.currentSession = null;
  await finder.noteRolloutAppeared(file);
  assert.equal(checks, 1, 'a known thread gaining its first rollout still resolves immediately');

  const quiet = Object.fromEntries(['approval-needed', 'turn-interrupted', 'limit-reached', 'turn-completed', 'turn-failed'].map(key => [key, false]));
  const calls = [];
  const notifier = new HudNotifier({ command: 'stub', runCommand: async (_, payload) => calls.push(JSON.parse(payload)) });
  const quota = { limit_id: 'codex', primary: { used_percent: 100, window_minutes: 300, resets_at: 2000000000 } };
  const quotaScope = rateLimitNotificationScope('account-a', quota);
  const context = { sessionId: 'one-session', cwd: root, quotaScope };
  notifier.observe(quiet, { ...context, turnId: 'turn-1' }, now);
  for (let i = 1; i <= 3; i++) notifier.observe({ ...quiet, 'limit-reached': true }, { ...context, turnId: `turn-${i}` }, now + i * 1000);
  assert.equal(calls.length, 1, 'turn changes do not reset account quota cooldown');
  notifier.observe({ ...quiet, 'limit-reached': true }, { ...context,
    quotaScope: rateLimitNotificationScope('account-a', { ...quota, primary: { ...quota.primary, resets_at: 2000018000 } }) }, now + 4000);
  assert.equal(calls.length, 2, 'a different quota window is an independent alert');
  notifier.observe({ ...quiet, 'turn-completed': true }, { ...context, turnId: 'one' }, now + 5000);
  notifier.observe({ ...quiet, 'turn-completed': true }, { ...context, turnId: 'two' }, now + 6000);
  assert.equal(calls.filter(call => call.event === 'turn-completed').length, 2);
  notifier.observe({ ...quiet, 'approval-needed': true }, { ...context, turnId: 'two', approvalId: 'a' }, now + 7000);
  notifier.observe({ ...quiet, 'approval-needed': true }, { ...context, turnId: 'two', approvalId: 'b' }, now + 8000);
  assert.equal(calls.filter(call => call.event === 'approval-needed').length, 2);

  const remaining = [{ id: 'unrelated', tmuxSession: 'other' }];
  assert.equal(selectedSession(remaining, 'removed'), undefined, 'removed explicit selection never targets another task');
  assert.equal(selectedSession(remaining, undefined), remaining[0], 'an initial unselected view can choose its first target');
  assert.equal(selectedSession(remaining, undefined, 'filtered-out'), remaining[0], 'a filter without an explicit selection can choose its first target');
  console.log('test-review-state-boundaries: PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
