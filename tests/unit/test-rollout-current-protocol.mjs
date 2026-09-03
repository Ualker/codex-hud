import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RolloutParser } from '../../dist/collectors/rollout.js';

const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'codex-hud-current-protocol-')
);
const rolloutPath = path.join(
  tempRoot,
  'rollout-2026-07-30T00-00-00-019b1111-a111-7111-8111-111111111111.jsonl'
);

function appendRecords(records) {
  fs.appendFileSync(
    rolloutPath,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8'
  );
}

try {
  appendRecords([
    {
      timestamp: '2026-07-30T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: '019b1111-a111-7111-8111-111111111111',
        timestamp: '2026-07-30T00:00:00.000Z',
        cwd: '/tmp/current-protocol',
        originator: 'codex-tui',
        cli_version: '0.146.0',
        source: 'cli',
      },
    },
    {
      timestamp: '2026-07-30T00:00:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_started',
        turn_id: 'turn-1',
        started_at: '2026-07-30T00:00:00.900Z',
        model_context_window: 258400,
      },
    },
    {
      timestamp: '2026-07-30T00:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'plan-1',
        name: 'update_plan',
        arguments: JSON.stringify({
          plan: [
            { step: 'inspect', status: 'completed' },
            { step: 'repair\u001b[31m', status: 'in_progress' },
          ],
        }),
      },
    },
    {
      timestamp: '2026-07-30T00:00:02.100Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'plan-1',
        output: '{}',
      },
    },
    {
      timestamp: '2026-07-30T00:00:03.000Z',
      type: 'response_item',
      payload: {
        type: 'tool_search_call',
        call_id: 'search-1',
        arguments: { query: 'fixture', limit: 5 },
        execution: 'client',
        status: 'completed',
      },
    },
    {
      timestamp: '2026-07-30T00:00:03.100Z',
      type: 'response_item',
      payload: {
        type: 'tool_search_output',
        call_id: 'search-1',
        execution: 'client',
        status: 'completed',
        tools: [{ name: 'fixture' }],
      },
    },
    {
      timestamp: '2026-07-30T00:00:04.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          model_context_window: 258400,
          last_token_usage: { total_tokens: 42000 },
        },
        rate_limits: {
          plan_type: 'plus',
          primary: {
            used_percent: 82,
            window_minutes: 300,
            resets_at: 1780000000,
          },
        },
      },
    },
  ]);

  const parser = new RolloutParser(10);
  parser.setRolloutPath(rolloutPath);

  const initial = await parser.parse();
  assert.equal(initial?.planProgress?.completedSteps, 1);
  assert.equal(initial?.planProgress?.steps[1]?.step, 'repair');
  assert.equal(initial?.rateLimits?.primary?.used_percent, 82);
  assert.equal(initial?.turnActivity?.phase, 'thinking');
  assert.equal(initial?.turnActivity?.turnId, 'turn-1');
  assert.equal(
    initial?.toolActivity.recentCalls.find((call) => call.id === 'search-1')?.name,
    'tool_search'
  );
  assert.equal(
    initial?.toolActivity.recentCalls.find((call) => call.id === 'search-1')?.status,
    'completed'
  );

  appendRecords([
    {
      timestamp: '2026-07-30T00:00:05.000Z',
      type: 'event_msg',
      payload: {
        type: 'agent_reasoning',
        text: 'content is intentionally ignored',
      },
    },
  ]);
  const afterUnrelatedAppend = await parser.parse();
  assert.equal(
    afterUnrelatedAppend?.planProgress?.steps[1]?.step,
    'repair',
    'an unrelated incremental event must not erase the current plan'
  );
  assert.equal(afterUnrelatedAppend?.rateLimits?.primary?.used_percent, 82);

  const replacementPlan = JSON.stringify({
    timestamp: '2026-07-30T00:00:06.000Z',
    type: 'event_msg',
    payload: {
      type: 'plan_update',
      plan: [
        { step: 'inspect', status: 'completed' },
        { step: '修复半行', status: 'completed' },
      ],
    },
  });
  const splitAt = Math.floor(replacementPlan.length / 2);
  fs.appendFileSync(rolloutPath, replacementPlan.slice(0, splitAt), 'utf8');

  const whilePartial = await parser.parse();
  assert.equal(
    whilePartial?.planProgress?.steps[1]?.step,
    'repair',
    'an incomplete trailing JSON line must remain uncommitted'
  );

  fs.appendFileSync(
    rolloutPath,
    `${replacementPlan.slice(splitAt)}\n`,
    'utf8'
  );
  const afterCompletion = await parser.parse();
  assert.equal(
    afterCompletion?.planProgress?.steps[1]?.step,
    '修复半行',
    'the completed trailing line must be parsed on the next pass'
  );

  appendRecords([
    {
      timestamp: '2026-07-30T00:00:06.100Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'parallel-a',
        name: 'read_file',
        arguments: '{}',
      },
    },
    {
      timestamp: '2026-07-30T00:00:06.200Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'parallel-b',
        name: 'read_file',
        arguments: '{}',
      },
    },
    {
      timestamp: '2026-07-30T00:00:06.300Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'parallel-a',
        output: '{}',
      },
    },
  ]);
  const whileParallel = await parser.parse();
  assert.equal(
    whileParallel?.turnActivity?.phase,
    'running-tool',
    'one completed parallel call must not hide another running call'
  );

  appendRecords([
    {
      timestamp: '2026-07-30T00:00:06.400Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'parallel-b',
        output: '{}',
      },
    },
  ]);
  const afterParallel = await parser.parse();
  assert.equal(afterParallel?.turnActivity?.phase, 'thinking');

  appendRecords([
    {
      timestamp: '2026-07-30T00:00:06.500Z',
      type: 'event_msg',
      payload: {
        type: 'task_started',
        turn_id: 'turn-2',
        started_at: '2026-07-30T00:00:06.500Z',
      },
    },
    {
      timestamp: '2026-07-30T00:00:06.600Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-1',
        completed_at: '2026-07-30T00:00:06.600Z',
      },
    },
  ]);
  const afterStaleComplete = await parser.parse();
  assert.equal(afterStaleComplete?.turnActivity?.phase, 'thinking');
  assert.equal(
    afterStaleComplete?.turnActivity?.turnId,
    'turn-2',
    'a late completion for an older turn must not mark the active turn idle'
  );

  appendRecords([
    {
      timestamp: '2026-07-30T00:00:07.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-2',
        completed_at: '2026-07-30T00:00:07.000Z',
        duration_ms: 6100,
        time_to_first_token_ms: 900,
      },
    },
    {
      timestamp: '2026-07-30T00:00:08.000Z',
      type: 'future_protocol_record',
      payload: { type: 'fixture' },
    },
  ]);
  const completed = await parser.parse();
  assert.equal(completed?.turnActivity?.phase, 'idle');
  assert.equal(completed?.turnActivity?.lastTurnDurationMs, 6100);
  assert.equal(completed?.turnActivity?.lastTimeToFirstTokenMs, 900);
  assert.equal(
    completed?.protocolHealth.unknownTopLevelTypes.future_protocol_record,
    1
  );

  // codex-cli 0.147+ writes the unified thread-item stream and subagent
  // spawn markers; both are known-and-ignored, not protocol drift.
  appendRecords([
    {
      timestamp: '2026-07-30T00:00:09.000Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: '019b1111-a111-7111-8111-111111111111',
        turn_id: 'turn-2',
        item: {
          type: 'CommandExecution',
          id: 'exec-11111111-2222-3333-4444-555555555555',
          process_id: '40737',
          command: ['/bin/zsh', '-lc', 'rg -n pattern src'],
          cwd: 'file:///tmp/current-protocol',
          exit_code: 0,
        },
      },
    },
    {
      timestamp: '2026-07-30T00:00:09.100Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: '019b1111-a111-7111-8111-111111111111',
        turn_id: 'turn-2',
        item: { type: 'AgentMessage', id: 'msg-1', text: 'done' },
      },
    },
    {
      timestamp: '2026-07-30T00:00:09.200Z',
      type: 'event_msg',
      payload: {
        type: 'sub_agent_activity',
        kind: 'started',
        event_id: 'spawn-1',
        occurred_at_ms: 1753833609200,
        agent_thread_id: '019b2222-b222-7222-8222-222222222222',
        agent_path: 'agents/explorer',
      },
    },
  ]);
  const withItemStream = await parser.parse();
  assert.deepEqual(
    withItemStream?.protocolHealth.unknownEventTypes,
    {},
    'the 0.147 item stream and spawn markers are known event types'
  );
  assert.equal(
    withItemStream?.protocolHealth.unknownTopLevelTypes.future_protocol_record,
    1,
    'earlier unknown counters carry across incremental parses'
  );

  // codex-cli 0.153+ persists each model response's token usage as its own
  // top-level record, 1:1 with the token_count event the parser consumes and
  // carrying the same figures; known-and-ignored, so it neither counts as
  // drift nor moves the token figures.
  const usage = {
    input_tokens: 22518,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 297,
    reasoning_output_tokens: 89,
    total_tokens: 22815,
  };
  appendRecords([
    {
      timestamp: '2026-07-30T00:00:09.300Z',
      type: 'token_usage_record',
      payload: {
        thread_id: '019b1111-a111-7111-8111-111111111111',
        turn_id: 'turn-2',
        session_id: '019b1111-a111-7111-8111-111111111111',
        root_turn_id: 'turn-2',
        response_id: 'resp_0ae826d112af6518016a98df819af487d0b9725316bd4ad140',
        usage,
        turn_token_usage: usage,
        thread_token_usage: usage,
      },
    },
  ]);
  const withUsageRecord = await parser.parse();
  assert.deepEqual(
    withUsageRecord?.protocolHealth.unknownTopLevelTypes,
    { future_protocol_record: 1 },
    'the 0.153 token_usage_record is a known top-level type'
  );
  assert.deepEqual(
    withUsageRecord?.tokenUsage,
    withItemStream?.tokenUsage,
    'token figures still come from token_count alone'
  );

  console.log('test-rollout-current-protocol: PASS');
} finally {
  const resolvedRoot = fs.realpathSync(tempRoot);
  assert.equal(path.dirname(resolvedRoot), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolvedRoot).startsWith('codex-hud-current-protocol-'));
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
}
