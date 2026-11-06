import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AgentActivityCollector } from '../../dist/collectors/agent-activity.js';
import { makeAgentTestRoot, cleanupAgentTestRoot, canonicalSessionMeta, taskStarted, taskComplete,
  legacyAgentStart, rolloutSessionFile } from '../helpers/agent-rollout-fixture.mjs';
import path from 'node:path';

const root = makeAgentTestRoot();
const rootId = '10000000-0000-7000-8000-000000000001';
const childId = '10000000-0000-7000-8000-000000000002';
const now = Math.floor(Date.now() / 1000) * 1000;
const timestamp = new Date(now).toISOString();
const encode = records => records.map(JSON.stringify).join('\n') + '\n';
const main = path.join(root, 'root.jsonl'), child = path.join(root, 'child.jsonl');
const agentPath = '/root/review';
const rootRecords = [canonicalSessionMeta({ id: rootId, timestamp }), taskStarted({ turnId: 'root-turn', timestamp, startedAt: now / 1000 }),
  legacyAgentStart({ childThreadId: childId, agentPath, timestamp, occurredAtMs: now })];
const meta = canonicalSessionMeta({ id: childId, timestamp, parentThreadId: rootId, agentPath,
  source: { subagent: { thread_spawn: { parent_thread_id: rootId, depth: 1, agent_path: agentPath } } } });
const started = taskStarted({ turnId: 'child-turn', timestamp, startedAt: now / 1000 });
const done = encode([meta, started, taskComplete({ turnId: 'child-turn', timestamp, completedAt: now / 1000 + 1 })]);
const running = encode([meta, started, { timestamp, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'padding'.repeat(100) }] } }]);
const create = options => {
  const collector = new AgentActivityCollector({ inactivityTimeoutMs: 900000,
    resolveRollout: id => id === childId ? rolloutSessionFile(child, childId) : null, logError: () => {}, ...options });
  collector.setRootSession(rolloutSessionFile(main, rootId));
  return collector;
};
try {
  fs.writeFileSync(main, encode(rootRecords));
  fs.writeFileSync(child, running);
  const collector = create();
  assert.equal((await collector.collect(now + 1000)).rows[0].status, 'running');
  fs.writeFileSync(`${child}.next`, done + ' '.repeat(Buffer.byteLength(running) - Buffer.byteLength(done)));
  fs.renameSync(`${child}.next`, child);
  assert.deepEqual(await collector.collect(now + 2000), await create().collect(now + 2000), 'same-size replacement matches a cold reader');
  fs.writeFileSync(child, done);
  assert.equal((await collector.collect(now + 3000)).visibleAgentCount, 0, 'truncation rebuilds the lifecycle');
  fs.writeFileSync(child, running.replace(childId, '20000000-0000-7000-8000-000000000002'));
  assert.equal((await collector.collect(now + 4000)).rows[0].status, 'tracking-error', 'a replacement must validate its identity');
  fs.writeFileSync(child, running);
  assert.equal((await collector.collect(now + 20000)).rows[0].status, 'running', 'valid replacement recovers after backoff');

  fs.writeFileSync(child, done);
  const idle = create({ idleCheckIntervalMs: 5000 });
  assert.equal((await idle.collect(now + 30000)).visibleAgentCount, 0);
  fs.appendFileSync(child, encode([taskStarted({ turnId: 'resumed', timestamp, startedAt: now / 1000 + 31 })]));
  assert.equal((await idle.collect(now + 31000)).visibleAgentCount, 0, 'idle fallback is throttled');
  assert.equal(idle.noteRolloutChanged(child), true);
  assert.equal((await idle.collect(now + 31001)).rows[0].status, 'running', 'a watcher event wakes an idle child immediately');
  fs.appendFileSync(child, encode([taskComplete({ turnId: 'resumed', timestamp, completedAt: now / 1000 + 32 })]));
  await idle.collect(now + 32000);
  fs.appendFileSync(child, encode([taskStarted({ turnId: 'fallback', timestamp, startedAt: now / 1000 + 33 })]));
  assert.equal((await idle.collect(now + 38000)).rows[0].status, 'running', 'a missed event still has a bounded fallback');

  fs.writeFileSync(main, encode(rootRecords.slice(0, 2)));
  assert.equal((await collector.collect(now + 40000)).visibleAgentCount, 0, 'root replacement discards the previous tree');
  console.log('test-agent-file-generations: PASS');
} finally { cleanupAgentTestRoot(root); }
