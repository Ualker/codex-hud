import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RolloutParser } from '../../dist/collectors/rollout.js';
import { renderHealthLine } from '../../dist/render/lines/activity-line.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-configuration-'));
const file = path.join(root, 'rollout.jsonl');
const fixture = JSON.parse(fs.readFileSync(
  new URL('../fixtures/protocol/0.165.0-configuration-update.jsonl', import.meta.url), 'utf8'
));
const timestamp = '2026-10-28T07:54:00.000Z';
let clock = Date.parse(timestamp);
const record = (type, payload) => ({ timestamp: new Date(clock += 1000).toISOString(), type, payload });
const line = (entry) => JSON.stringify(entry) + '\n';
const append = (type, payload) => fs.appendFileSync(file, line(record(type, payload)));
const meta = { id: 'configuration-session', timestamp, cwd: '/tmp/configuration', cli_version: '0.165.0', source: 'cli' };
const healthy = { unknownTopLevelTypes: {}, unknownResponseTypes: {}, unknownEventTypes: {}, malformedLines: 0 };
function parserFor(target = file) {
  const parser = new RolloutParser(10);
  parser.setRolloutPath(target);
  return parser;
}
function assertConfigurationOnly(actual, before, effort) {
  assert.deepEqual(actual.protocolHealth, healthy);
  assert.equal(renderHealthLine(actual), null, 'configuration updates must not produce compatibility warnings');
  assert.deepEqual(actual.session, { ...before.session, reasoningEffort: effort });
  for (const field of ['tokenUsage', 'rateLimits', 'turnActivity', 'planProgress',
    'lastAssistantMessageTime', 'lastToolActivityTime']) {
    assert.deepEqual(actual[field], before[field], `configuration must not invent ${field}`);
  }
  // Log freshness can advance before any tool call; call state must not.
  for (const field of ['totalCalls', 'callsByType', 'recentCalls', 'runningCalls']) {
    assert.deepEqual(actual.toolActivity[field], before.toolActivity[field], `configuration must not change ${field}`);
  }
}

try {
  append('session_meta', meta);
  append('turn_context', { model: 'gpt-6-astra', effort: 'low', approval_policy: 'never' });
  append('event_msg', { type: 'task_started', turn_id: 'turn-1' });
  append('event_msg', {
    type: 'token_count', info: { last_token_usage: { total_tokens: 54000 }, model_context_window: 258400 },
    rate_limits: { secondary: { used_percent: 4, window_minutes: 10080, resets_at: 1793745300 } },
  });
  append('event_msg', { type: 'plan_update', plan: [{ step: 'Read configuration', status: 'in_progress' }] });
  const parser = parserFor();
  for (const [phase, effort] of [['thinking', 'max'], ['running-tool', 'high'], ['idle', 'low']]) {
    if (phase === 'running-tool') {
      append('response_item', { type: 'function_call', name: 'exec_command', call_id: 'exec-1', arguments: '{}' });
    } else if (phase === 'idle') {
      append('response_item', { type: 'function_call_output', call_id: 'exec-1', output: '{}' });
      append('event_msg', { type: 'agent_message', turn_id: 'turn-1', message: 'Done.' });
      append('event_msg', { type: 'task_complete', turn_id: 'turn-1' });
    }
    const before = await parser.parse();
    assert.ok(Number.isFinite(before.session.startTime.getTime()));
    assert.equal(before.turnActivity.phase, phase);
    append(fixture.type, { ...fixture.payload, reasoning: { effort } });
    assertConfigurationOnly(await parser.parse(), before, effort);
    assertConfigurationOnly(await parserFor().parse(), before, effort);
  }

  // Partial configuration records do not erase an already known setting.
  const beforePartial = await parser.parse();
  for (const fields of [{}, { reasoning: null }, { reasoning: {} },
    { reasoning: { effort: null } }, { reasoning: { effort: '' } }]) {
    append('response_item', { type: 'configuration_update', ...fields });
    assertConfigurationOnly(await parser.parse(), beforePartial, 'low');
  }
  append('turn_context', { effort: 'medium' });
  assert.equal((await parser.parse()).session.reasoningEffort, 'medium');
  append('event_msg', { type: 'thread_settings_applied', thread_settings: { reasoning_effort: 'high' } });
  assert.equal((await parser.parse()).session.reasoningEffort, 'high');

  // Invalid consumed fields and wrong namespaces still surface as warnings.
  for (const reasoning of ['max', [], { effort: 42 }]) {
    append('response_item', { type: 'configuration_update', reasoning });
  }
  append('event_msg', { type: 'configuration_update', reasoning: { effort: 'low' } });
  append('response_item', { type: 'future_configuration_update' });
  const expected = {
    unknownTopLevelTypes: {}, unknownResponseTypes: { future_configuration_update: 1 },
    unknownEventTypes: { configuration_update: 1 }, malformedLines: 3,
  };
  for (const parsed of [await parser.parse(), await parserFor().parse(), await parser.parse()]) {
    assert.deepEqual(parsed.protocolHealth, expected);
    assert.equal(parsed.session.reasoningEffort, 'high');
    assert.notEqual(renderHealthLine(parsed), null);
  }

  // A restart must recover the latest setting even when it is outside both
  // initial read windows; unrelated transcript must not become tool activity.
  const big = path.join(root, 'large-rollout.jsonl');
  const filler = () => record('response_item', {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(70 * 1024) }],
  });
  fs.writeFileSync(big, [record('session_meta', meta), record('turn_context', { effort: 'low' }), filler(),
    record('response_item', { type: 'configuration_update', reasoning: { effort: 42 } }),
    record(fixture.type, fixture.payload), ...Array.from({ length: 40 }, filler),
    record('event_msg', { type: 'task_started', turn_id: 'large-turn' }),
    record('event_msg', { type: 'token_count', info: { last_token_usage: { total_tokens: 100 }, model_context_window: 1000 } }),
  ].map(line).join(''));
  const largeParser = parserFor(big);
  const large = await largeParser.parse();
  assert.equal(large.partialHistory, true);
  assert.equal(large.session.reasoningEffort, 'max');
  assert.equal(large.turnActivity.phase, 'thinking');
  assert.equal(large.toolActivity.totalCalls, 0);
  assert.equal(large.tokenUsage.last_token_usage.total_tokens, 100);
  assert.deepEqual(large.protocolHealth, { ...healthy, malformedLines: 1 });
  fs.appendFileSync(big, line(record('turn_context', { effort: 'medium' })));
  assert.equal((await largeParser.parse()).session.reasoningEffort, 'medium');
  assert.equal((await parserFor(big).parse()).session.reasoningEffort, 'medium');
  console.log('test-rollout-configuration-update: PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
