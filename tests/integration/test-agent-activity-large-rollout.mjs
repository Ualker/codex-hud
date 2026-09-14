import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  makeAgentTestRoot, cleanupAgentTestRoot, writeRolloutFile,
  canonicalSessionMeta, taskStarted, taskComplete, legacyAgentStart,
  appendRolloutRecords, rolloutSessionFile,
} from '../helpers/agent-rollout-fixture.mjs';
import { AgentActivityCollector } from '../../dist/collectors/agent-activity.js';

const root = makeAgentTestRoot();
const time = (ms) => new Date(ms).toISOString();
const start = (turnId, ms) => taskStarted({ turnId, timestamp: time(ms), startedAt: ms / 1000 });
const spawn = (id, agentPath, ms) => legacyAgentStart({
  childThreadId: id, agentPath, occurredAtMs: ms, timestamp: time(ms), eventId: `spawn-${id}`,
});
const meta = (id, parent, agentPath) => canonicalSessionMeta({
  id, timestamp: time(1000),
  ...(parent ? {
    source: { subagent: { thread_spawn: { parent_thread_id: parent, agent_path: agentPath, depth: 1 } } },
    parentThreadId: parent, agentPath,
  } : {}),
});
function pad(file) {
  // Each line fits the per-record guard; the complete history exceeds the
  // former 64 MiB batch limit. Never materialize that whole fixture in JS.
  const line = Buffer.from(JSON.stringify({
    timestamp: time(4000), type: 'response_item',
    payload: { type: 'function_call_output', output: 'x'.repeat(1024 * 1024) },
  }) + '\n');
  const fd = fs.openSync(file, 'a');
  try { for (let i = 0; i < 65; i++) fs.writeSync(fd, line); }
  finally { fs.closeSync(fd); }
  assert.ok(fs.statSync(file).size > 64 * 1024 * 1024);
}

try {
  const source = writeRolloutFile(root, { sessionId: 'source', records: [meta('source'), start('inherited', 1000)] });
  pad(source);
  const parent = writeRolloutFile(root, { sessionId: 'parent', records: [
    { ...meta('parent'), payload: { ...meta('parent').payload, forked_from_id: 'source' } },
    start('inherited', 1000), spawn('copied-root', '/root/copied', 2000),
  ] });
  pad(parent);
  appendRolloutRecords(parent, [start('parent-local', 5000), spawn('child', '/root/child', 6000)]);
  const child = writeRolloutFile(root, { sessionId: 'child', records: [
    meta('child', 'parent', '/root/child'), start('parent-local', 5000),
    spawn('copied-child', '/root/copied_child', 6000), start('child-local', 7000),
  ] });
  pad(child);
  appendRolloutRecords(child, [spawn('grandchild', '/root/child/grandchild', 8000)]);
  const grandchild = writeRolloutFile(root, { sessionId: 'grandchild', records: [
    meta('grandchild', 'child', '/root/child/grandchild'),
    start('child-local', 7000), start('grandchild-local', 9000),
  ] });
  const files = new Map([['source', source], ['parent', parent], ['child', child], ['grandchild', grandchild]]);
  const resolved = [];
  const collector = new AgentActivityCollector({
    inactivityTimeoutMs: 900_000,
    resolveRollout(id) {
      resolved.push(id);
      assert.ok(files.has(id), `inherited agent ${id} must not be tracked`);
      return rolloutSessionFile(files.get(id), id);
    },
    logError(message) { assert.fail(message); },
  });
  collector.setRootSession(rolloutSessionFile(parent, 'parent'));
  const first = await collector.collect(10_000);
  assert.equal(first.rootTrackingError, false);
  assert.equal(first.visibleAgentCount, 2);
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0].status, 'running');
  assert.equal(first.rows[0].activeDescendantCount, 1);
  assert.equal(first.rows[0].elapsedStartedAt.getTime(), 7000);
  assert.deepEqual(resolved, ['source', 'child', 'grandchild']);

  await collector.collect(10_100);
  assert.deepEqual(resolved, ['source', 'child', 'grandchild'], 'unchanged history is cached');
  for (const [file, turnId] of [[child, 'child-local'], [grandchild, 'grandchild-local']]) {
    appendRolloutRecords(file, [taskComplete({ turnId, timestamp: time(11_000) })]);
  }
  const completed = await collector.collect(12_000);
  assert.equal(completed.visibleAgentCount, 0, 'incremental completions still retire the tree');
  assert.deepEqual(completed.rows, []);

  // A later backlog can also exceed 64 MiB. A bad record at its end must
  // leave the old cursor and tree intact, then permit a complete retry.
  const later = writeRolloutFile(root, { sessionId: 'later', records: [
    meta('later', 'parent', '/root/later'), start('later-local', 15_000),
  ] });
  files.set('later', later);
  appendRolloutRecords(parent, [spawn('later', '/root/later', 14_000)]);
  pad(parent);
  const repairOffset = fs.statSync(parent).size;
  fs.appendFileSync(parent, '{bad record}\n');
  await assert.rejects(collector.collect(16_000));
  assert.equal(resolved.includes('later'), false, 'no partial tree is published after a failed scan');
  fs.truncateSync(parent, repairOffset);
  const recovered = await collector.collect(17_000);
  assert.equal(recovered.visibleAgentCount, 1);
  assert.equal(recovered.rows[0].label, 'later');
  assert.equal(resolved.filter((id) => id === 'later').length, 1);
  console.log('test-agent-activity-large-rollout: PASS (root, child and fork source each >64 MiB)');
} finally {
  cleanupAgentTestRoot(root);
}
