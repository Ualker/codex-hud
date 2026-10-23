import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RolloutParser } from '../../dist/collectors/rollout.js';
import { renderHealthLine } from '../../dist/render/lines/activity-line.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-additional-tools-'));
const file = path.join(root, 'rollout.jsonl');
const definition = JSON.parse(fs.readFileSync(
  new URL('../fixtures/protocol/0.164.0-additional-tools.jsonl', import.meta.url), 'utf8'
));
let clock = Date.parse('2026-10-23T05:52:59Z');
function append(type, payload) {
  fs.appendFileSync(file, JSON.stringify({ timestamp: new Date(clock += 1000).toISOString(), type, payload }) + '\n');
}
function createParser() {
  const parser = new RolloutParser(10);
  parser.setRolloutPath(file);
  return parser;
}
const healthy = { unknownTopLevelTypes: {}, unknownResponseTypes: {}, unknownEventTypes: {}, malformedLines: 0 };
function assertMetadataOnly(actual, before) {
  assert.deepEqual(actual.protocolHealth, healthy, 'tool definitions must not produce protocol warnings');
  assert.equal(renderHealthLine(actual), null, 'the compatibility warning must disappear from the HUD');
  for (const field of ['session', 'tokenUsage', 'rateLimits', 'turnActivity',
    'planProgress', 'lastAssistantMessageTime', 'lastToolActivityTime']) {
    assert.deepEqual(actual[field], before[field], `tool definitions must not change ${field}`);
  }
  // lastUpdateTime also tracks log freshness before the first invocation.
  for (const field of ['totalCalls', 'callsByType', 'recentCalls', 'runningCalls']) {
    assert.deepEqual(actual.toolActivity[field], before.toolActivity[field], `tool definitions must not change ${field}`);
  }
}

try {
  append('session_meta', {
    id: 'additional-tools-session', cwd: '/tmp/additional-tools', cli_version: '0.164.0', source: 'cli',
  });
  append('event_msg', { type: 'task_started', turn_id: 'turn-1' });
  append('event_msg', {
    type: 'token_count',
    info: { last_token_usage: { total_tokens: 53920 }, model_context_window: 258400 },
    rate_limits: { secondary: { used_percent: 1, window_minutes: 10080, resets_at: 1793318400 } },
  });
  append('event_msg', { type: 'plan_update', plan: [{ step: 'Read the fixture', status: 'in_progress' }] });
  const parser = createParser();

  // Definitions can arrive before an invocation, during execution, or after
  // a reply. Neither incremental reads nor cold replay may invent activity.
  for (const phase of ['thinking', 'running-tool', 'idle']) {
    if (phase === 'running-tool') {
      append('response_item', { type: 'function_call', name: 'exec_command', call_id: 'exec-1', arguments: '{}' });
    } else if (phase === 'idle') {
      append('response_item', { type: 'function_call_output', call_id: 'exec-1', output: '{}' });
      append('event_msg', { type: 'agent_message', turn_id: 'turn-1', message: 'Fixture done.' });
      append('event_msg', { type: 'task_complete', turn_id: 'turn-1' });
    }
    const before = await parser.parse();
    assert.equal(before.turnActivity.phase, phase);
    append(definition.type, { ...definition.payload, id: `tools-${phase}` });
    assertMetadataOnly(await parser.parse(), before);
    assertMetadataOnly(await createParser().parse(), before);
  }

  // Recognition is exact and namespace-specific; future protocol drift and
  // invalid consumed fields still surface instead of being hidden globally.
  append('response_item', { type: 'future_tool_definition' });
  append('event_msg', { type: 'additional_tools' });
  append('response_item', { ...definition.payload, role: 42 });
  const expected = {
    unknownTopLevelTypes: {}, unknownResponseTypes: { future_tool_definition: 1 },
    unknownEventTypes: { additional_tools: 1 }, malformedLines: 1,
  };
  const result = await parser.parse();
  assert.deepEqual(result.protocolHealth, expected);
  assert.notEqual(renderHealthLine(result), null, 'real compatibility and invalid-record warnings remain visible');
  assert.deepEqual((await createParser().parse()).protocolHealth, expected);
  assert.deepEqual((await parser.parse()).protocolHealth, expected, 'unchanged logs do not double-count warnings');
  console.log('test-rollout-additional-tools: PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
