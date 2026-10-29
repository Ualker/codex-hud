import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RolloutParser } from '../../dist/collectors/rollout.js';
import { canonicalSessionMeta } from '../helpers/agent-rollout-fixture.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-batch-invariance-'));
const file = path.join(root, 'rollout.jsonl');
const record = (type, payload, second) => ({ timestamp: `2026-10-29T00:00:0${second}.000Z`, type, payload });
const records = [
  canonicalSessionMeta(),
  record('response_item', { type: 'custom_tool_call', call_id: 'exec-1', name: 'exec', input: 'const r = await tools.exec_command({cmd:"false"}); text(r.output);' }, 1),
  record('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', exit_code: 7, command: 'false' } }, 2),
  record('response_item', { type: 'custom_tool_call_output', call_id: 'exec-1', output: 'Script completed\nWall time: 0.2 seconds\nOutput:\n' }, 3),
  record('response_item', { type: 'custom_tool_call', call_id: 'web-1', name: 'exec', input: 'const r = await tools.web__run(request); text(r);' }, 4),
  record('event_msg', { type: 'item_completed', item: { type: 'Extension', kind: 'web.search', query: 'batch boundary query' } }, 5),
  record('response_item', { type: 'custom_tool_call_output', call_id: 'web-1', output: 'done' }, 6),
];
const encode = rows => rows.map(JSON.stringify).join('\n') + '\n';
try {
  fs.writeFileSync(file, encode(records));
  const full = new RolloutParser(); full.setRolloutPath(file);
  const expected = (await full.parse()).toolActivity;
  assert.equal(expected.recentCalls[0].status, 'error');
  assert.equal(expected.recentCalls[0].result.exitCode, 7);
  assert.equal(expected.recentCalls[1].summary, 'batch boundary query');
  // Every partition, including one record per append, must render identically.
  for (let mask = 0; mask < 1 << (records.length - 1); mask++) {
    fs.writeFileSync(file, '');
    const parser = new RolloutParser(); parser.setRolloutPath(file);
    let batch = [];
    let latest;
    for (let i = 0; i < records.length; i++) {
      batch.push(records[i]);
      if ((mask & (1 << i)) || i === records.length - 1) {
        fs.appendFileSync(file, encode(batch)); batch = [];
        latest = await parser.parse();
      }
    }
    assert.deepEqual(latest.toolActivity, expected, `partition ${mask}`);
  }
  for (const terminal of ['task_complete', 'turn_aborted']) {
    fs.writeFileSync(file, encode(records.slice(0, 3)));
    const parser = new RolloutParser(); parser.setRolloutPath(file); await parser.parse();
    fs.appendFileSync(file, encode([record('event_msg', { type: terminal }, 4)]));
    const result = await parser.parse();
    assert.equal(result.toolActivity.runningCalls.length, 0);
    assert.equal(result.toolActivity.recentCalls[0].result.exitCode, 7);
    // Full parse / file replacement / rebind must not inherit the old failure.
    const clean = [records[0], records[1], records[3]];
    fs.writeFileSync(file, encode(clean));
    assert.equal((await parser.fullParse()).toolActivity.recentCalls[0].status, 'completed');
    const replacement = path.join(root, 'replacement');
    fs.writeFileSync(replacement, encode(clean)); fs.renameSync(replacement, file);
    assert.equal((await parser.parse()).toolActivity.recentCalls[0].status, 'completed');
    parser.setRolloutPath(null); parser.setRolloutPath(file);
    assert.equal((await parser.parse()).toolActivity.recentCalls[0].status, 'completed');
  }
  console.log('test-rollout-batch-invariance: PASS (64 partitions, terminal/reset paths)');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
