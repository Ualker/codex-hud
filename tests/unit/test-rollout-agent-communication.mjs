import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RolloutParser } from '../../dist/collectors/rollout.js';
import { normalizeRolloutRecord, KNOWN_TOP_LEVEL_TYPES, KNOWN_RESPONSE_TYPES, KNOWN_EVENT_TYPES } from '../../dist/protocol/rollout-record.js';
import { normalizeAgentSpawnSeed } from '../../dist/collectors/agent-activity.js';
for (const line of fs.readFileSync(new URL('../fixtures/protocol/0.157.1-communication.jsonl',import.meta.url),'utf8').trim().split('\n')) {
  const record=normalizeRolloutRecord(JSON.parse(line));
  assert.ok(record);assert.ok(KNOWN_TOP_LEVEL_TYPES.has(record.type));
  if(record.type==='response_item') assert.ok(KNOWN_RESPONSE_TYPES.has(record.payload.type));
  if(record.type==='event_msg') assert.ok(KNOWN_EVENT_TYPES.has(record.payload.type));
  assert.equal(normalizeAgentSpawnSeed(record),null,'communication and completion records are not spawns');
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-agent-communication-'));
const rolloutPath = path.join(tempRoot, 'rollout.jsonl');
let clock = Date.parse('2026-09-26T05:37:00.000Z');

function append(type, payload) {
  const timestamp = new Date(clock += 1000).toISOString();
  fs.appendFileSync(rolloutPath, `${JSON.stringify({ timestamp, type, payload })}\n`);
  return timestamp;
}

function createParser() {
  const parser = new RolloutParser(10);
  parser.setRolloutPath(rolloutPath);
  return parser;
}

const healthy = {
  unknownTopLevelTypes: {},
  unknownResponseTypes: {},
  unknownEventTypes: {},
  malformedLines: 0,
};

function assertCommunicationState(actual, before) {
  assert.deepEqual(actual.protocolHealth, healthy, 'agent communication is recognized');
  assert.deepEqual(actual.turnActivity, before.turnActivity, 'incoming messages do not change turn state');
  assert.deepEqual(actual.lastAssistantMessageTime, before.lastAssistantMessageTime,
    'incoming messages are not assistant replies');
  assert.deepEqual(actual.tokenUsage, before.tokenUsage);
  assert.deepEqual(actual.session, before.session);
  assert.equal(actual.toolActivity.totalCalls, before.toolActivity.totalCalls);
  assert.deepEqual(actual.toolActivity.recentCalls, before.toolActivity.recentCalls);
}

try {
  append('session_meta', {
    id: 'communication-session',
    timestamp: new Date(clock).toISOString(),
    cwd: '/tmp/agent-communication',
    cli_version: '0.157.1',
    source: 'cli',
  });
  append('event_msg', { type: 'task_started', turn_id: 'turn-1' });
  append('event_msg', {
    type: 'token_count',
    info: { last_token_usage: { total_tokens: 100 }, model_context_window: 258400 },
  });
  append('response_item', {
    type: 'function_call', call_id: 'exec-1', name: 'exec_command', arguments: '{}',
  });
  const parser = createParser();
  let before = await parser.parse();
  assert.equal(before.turnActivity.phase, 'running-tool');

  // Real 0.157.1 rollouts pair this top-level marker with an agent_message
  // response item. Parse each separately too: they can arrive across reads.
  for (const triggerTurn of [false, true]) {
    append('inter_agent_communication_metadata', { trigger_turn: triggerTurn });
    assertCommunicationState(await parser.parse(), before);
    append('response_item', {
      type: 'agent_message',
      id: `amsg_${triggerTurn}`,
      author: triggerTurn ? '/root' : '/root/reviewer',
      recipient: triggerTurn ? '/root/reviewer' : '/root',
      content: [
        { type: 'input_text', text: 'Review progress.' },
        { type: 'encrypted_content', encrypted_content: 'fixture' },
      ],
      internal_chat_message_metadata_passthrough: {
        turn_id: 'turn-1', create_time: clock / 1000,
      },
    });
    assertCommunicationState(await parser.parse(), before);
    assertCommunicationState(await createParser().parse(), before);

    if (!triggerTurn) {
      append('response_item', {
        type: 'function_call_output', call_id: 'exec-1', output: '{}',
      });
      append('event_msg', { type: 'task_complete', turn_id: 'turn-1' });
      before = await parser.parse();
      assert.equal(before.turnActivity.phase, 'idle');
    }
  }

  // The existing event with the same name still represents an assistant
  // reply; only response_item/agent_message is inter-agent communication.
  append('event_msg', { type: 'task_started', turn_id: 'turn-2' });
  const replyAt = append('event_msg', {
    type: 'agent_message', turn_id: 'turn-2', message: 'Reply to the user.',
  });
  const responding = await parser.parse();
  assert.equal(responding.turnActivity.phase, 'responding');
  assert.equal(responding.lastAssistantMessageTime.toISOString(), replyAt);

  // Recognition is specific: real protocol drift must remain visible.
  append('future_protocol_record', {});
  append('response_item', { type: 'future_response' });
  append('event_msg', { type: 'future_event' });
  const expectedHealth = {
    unknownTopLevelTypes: { future_protocol_record: 1 },
    unknownResponseTypes: { future_response: 1 },
    unknownEventTypes: { future_event: 1 },
    malformedLines: 0,
  };
  assert.deepEqual((await parser.parse()).protocolHealth, expectedHealth);
  assert.deepEqual((await createParser().parse()).protocolHealth, expectedHealth);
  assert.deepEqual((await parser.parse()).protocolHealth, expectedHealth,
    'an unchanged rollout must not double-count unknown records');

  console.log('test-rollout-agent-communication: PASS');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
