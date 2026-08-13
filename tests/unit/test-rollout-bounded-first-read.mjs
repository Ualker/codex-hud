import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RolloutParser } from '../../dist/collectors/rollout.js';

const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'codex-hud-bounded-read-')
);

function rolloutPath(name) {
  return path.join(tempRoot, `rollout-2026-08-12T00-00-00-${name}.jsonl`);
}

const sessionMeta = (id) => ({
  timestamp: '2026-08-12T00:00:00.000Z',
  type: 'session_meta',
  payload: {
    id,
    timestamp: '2026-08-12T00:00:00.000Z',
    cwd: '/tmp/bounded-read',
    originator: 'codex-tui',
    cli_version: '0.147.0',
    source: 'cli',
  },
});

const tokenCount = (total) => ({
  timestamp: '2026-08-12T02:00:00.000Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      model_context_window: 258400,
      last_token_usage: { total_tokens: total },
      total_token_usage: { total_tokens: total * 3 },
    },
  },
});

const turnContext = ({
  approval = 'never',
  sandbox = 'danger-full-access',
  model = 'gpt-5.6-sol',
  effort = 'max',
  nestedEffort = 'low',
  instructions,
} = {}) => ({
  timestamp: '2026-08-12T01:30:00.000Z',
  type: 'turn_context',
  payload: {
    approval_policy: approval,
    sandbox_policy: { type: sandbox },
    model,
    effort,
    collaboration_mode: {
      settings: {
        model,
        reasoning_effort: nestedEffort,
        ...(instructions ? { developer_instructions: instructions } : {}),
      },
    },
  },
});

const updatePlan = (statuses) => ({
  timestamp: '2026-08-12T01:31:00.000Z',
  type: 'response_item',
  payload: {
    type: 'custom_tool_call',
    call_id: 'middle-plan',
    name: 'exec',
    input: `const r = await tools.update_plan({plan:${JSON.stringify(
      statuses.map((status, index) => ({ step: `step ${index + 1}`, status }))
    )}}); text(r);`,
  },
});

/** A record big enough to push the file past the head+tail budget quickly. */
const filler = (index) => ({
  timestamp: '2026-08-12T01:00:00.000Z',
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: `${index}:${'x'.repeat(64 * 1024)}` }],
  },
});

function write(file, records) {
  fs.writeFileSync(
    file,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8'
  );
}

try {
  // ---- a large rollout reads a bounded head and tail -----------------------
  const big = rolloutPath('019f1111-a111-7111-8111-111111111111');
  const midCalls = [];
  for (let i = 0; i < 4; i++) {
    midCalls.push({
      timestamp: '2026-08-12T01:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: `mid-${i}`,
        name: 'read_file',
        arguments: '{}',
      },
    });
    midCalls.push(filler(i));
  }
  write(big, [
    sessionMeta('019f1111-a111-7111-8111-111111111111'),
    ...midCalls,
    turnContext(),
    {
      timestamp: '2026-08-12T01:30:30.000Z',
      type: 'compacted',
      payload: {},
    },
    updatePlan(['completed', 'in_progress', 'pending']),
    // 40 fillers ≈ 2.6MB, comfortably past the 64KB head + 2MB tail budget.
    ...Array.from({ length: 40 }, (_, i) => filler(100 + i)),
    {
      timestamp: '2026-08-12T02:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'tail-1',
        name: 'exec_command',
        arguments: JSON.stringify({ command: ['rg', 'pattern'] }),
      },
    },
    tokenCount(154940),
    {
      timestamp: '2026-08-12T02:00:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-1',
        completed_at: '2026-08-12T02:00:01.000Z',
      },
    },
  ]);
  assert.ok(
    fs.statSync(big).size > 2 * 1024 * 1024,
    'the fixture must exceed the bounded-read budget'
  );

  const parser = new RolloutParser(10);
  parser.setRolloutPath(big);
  const result = await parser.parse();

  assert.equal(result.partialHistory, true, 'a bounded read is reported as such');
  assert.equal(
    result.session?.id,
    '019f1111-a111-7111-8111-111111111111',
    'session_meta is recovered from the head even though the middle is skipped'
  );
  assert.deepEqual(
    {
      model: result.session?.model,
      reasoningEffort: result.session?.reasoningEffort,
      approvalPolicy: result.session?.approvalPolicy,
      sandboxMode: result.session?.sandboxMode,
    },
    {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'max',
      approvalPolicy: 'never',
      sandboxMode: 'danger-full-access',
    },
    'skipped-middle turn_context state is recovered without replaying tools'
  );
  assert.equal(
    result.compactCount,
    1,
    'skipped-middle compactions remain an accurate lower-bound component'
  );
  assert.equal(result.planProgress?.completedSteps, 1);
  assert.equal(result.planProgress?.totalSteps, 3);
  assert.equal(
    result.tokenUsage?.last_token_usage?.total_tokens,
    154940,
    'context capacity comes from the tail'
  );
  assert.equal(result.turnActivity?.phase, 'idle');
  assert.equal(
    result.protocolHealth.malformedLines,
    0,
    'the tail read aligns to a line start instead of parsing a leading fragment'
  );

  // Head records other than session_meta must NOT be replayed: a function_call
  // whose completion fell in the skipped middle would stay "running" forever
  // and pin the turn phase.
  assert.equal(
    result.toolActivity.recentCalls.some((call) => call.id.startsWith('mid-')),
    false,
    'skipped-middle calls never enter the tool list'
  );
  assert.ok(
    result.toolActivity.recentCalls.some((call) => call.id === 'tail-1'),
    'tail calls are parsed normally'
  );

  // ---- incremental parses stay incremental and stay honest ----------------
  const beforeAppend = result.toolActivity.totalCalls;
  fs.appendFileSync(
    big,
    `${JSON.stringify({
      timestamp: '2026-08-12T02:05:00.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'after-1',
        name: 'read_file',
        arguments: '{}',
      },
    })}\n`,
    'utf8'
  );
  const incremental = await parser.parse();
  assert.equal(
    incremental.toolActivity.totalCalls,
    beforeAppend + 1,
    'the committed offset from a tail read continues incrementally'
  );
  assert.ok(
    incremental.toolActivity.recentCalls.some((call) => call.id === 'after-1')
  );
  assert.equal(
    incremental.partialHistory,
    true,
    'partialHistory is sticky across later incremental parses'
  );

  // ---- a turn_context cut by the tail boundary is still recovered --------
  // This is the live failure shape: the 2 MB tail begins inside the latest
  // turn_context, so the tail reader discards its leading fragment.
  const boundary = rolloutPath('019f4444-d444-7444-8444-444444444444');
  const tailBytes = 2 * 1024 * 1024;
  const boundaryContext = turnContext({
    model: 'gpt-5.6-boundary',
    effort: 'xhigh',
    nestedEffort: 'low',
    instructions: 'i'.repeat(32 * 1024),
  });
  const prefixRecords = [
    sessionMeta('019f4444-d444-7444-8444-444444444444'),
    turnContext({
      approval: 'on-request',
      sandbox: 'workspace-write',
      model: 'gpt-5.5-old',
      effort: 'low',
    }),
    filler(900),
  ];
  const suffixRecords = [
    tokenCount(9001),
    {
      timestamp: '2026-08-12T02:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'boundary-turn' },
    },
  ];
  const serialize = (record) => `${JSON.stringify(record)}\n`;
  const prefixText = prefixRecords.map(serialize).join('');
  const contextText = serialize(boundaryContext);
  const suffixText = suffixRecords.map(serialize).join('');
  const paddingRecord = filler(901);
  paddingRecord.payload.content[0].text = '';
  const emptyPaddingText = serialize(paddingRecord);
  const desiredBytesAfterContextStart = tailBytes + 1024;
  const paddingLength =
    desiredBytesAfterContextStart -
    Buffer.byteLength(contextText) -
    Buffer.byteLength(emptyPaddingText) -
    Buffer.byteLength(suffixText);
  assert.ok(paddingLength > 0, 'boundary fixture needs positive tail padding');
  paddingRecord.payload.content[0].text = 'p'.repeat(paddingLength);
  const boundaryText =
    prefixText + contextText + serialize(paddingRecord) + suffixText;
  fs.writeFileSync(boundary, boundaryText, 'utf8');

  const boundaryStart = Buffer.byteLength(prefixText);
  const tailStart = fs.statSync(boundary).size - tailBytes;
  assert.ok(tailStart > boundaryStart);
  assert.ok(
    tailStart < boundaryStart + Buffer.byteLength(contextText),
    'the bounded tail must start inside the latest turn_context line'
  );

  const boundaryParser = new RolloutParser(10);
  boundaryParser.setRolloutPath(boundary);
  const boundaryResult = await boundaryParser.parse();
  assert.equal(boundaryResult.partialHistory, true);
  assert.deepEqual(
    {
      model: boundaryResult.session?.model,
      reasoningEffort: boundaryResult.session?.reasoningEffort,
      approvalPolicy: boundaryResult.session?.approvalPolicy,
      sandboxMode: boundaryResult.session?.sandboxMode,
    },
    {
      model: 'gpt-5.6-boundary',
      reasoningEffort: 'xhigh',
      approvalPolicy: 'never',
      sandboxMode: 'danger-full-access',
    },
    'the crossing turn_context must override stale head settings'
  );

  // ---- a small rollout is still read whole --------------------------------
  const small = rolloutPath('019f2222-b222-7222-8222-222222222222');
  write(small, [
    sessionMeta('019f2222-b222-7222-8222-222222222222'),
    {
      timestamp: '2026-08-12T01:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'small-1',
        name: 'read_file',
        arguments: '{}',
      },
    },
    tokenCount(1000),
  ]);
  const smallParser = new RolloutParser(10);
  smallParser.setRolloutPath(small);
  const smallResult = await smallParser.parse();
  assert.equal(
    smallResult.partialHistory,
    false,
    'a file inside the budget is read in full'
  );
  assert.ok(
    smallResult.toolActivity.recentCalls.some((call) => call.id === 'small-1')
  );

  // ---- a tail with no token_count falls back to the whole file ------------
  // One turn with an enormous tool output can fill the tail alone. Context
  // capacity is the HUD's most-read cell, so it is worth the full read.
  const noTokens = rolloutPath('019f3333-c333-7333-8333-333333333333');
  write(noTokens, [
    sessionMeta('019f3333-c333-7333-8333-333333333333'),
    tokenCount(4242),
    ...Array.from({ length: 40 }, (_, i) => filler(i)),
  ]);
  const fallbackParser = new RolloutParser(10);
  fallbackParser.setRolloutPath(noTokens);
  const fallback = await fallbackParser.parse();
  assert.equal(
    fallback.tokenUsage?.last_token_usage?.total_tokens,
    4242,
    'a tail without token_count re-reads the file so capacity is not lost'
  );
  assert.equal(
    fallback.partialHistory,
    false,
    'the full re-read is not reported as partial'
  );

  console.log('test-rollout-bounded-first-read: PASS');
} finally {
  const resolvedRoot = fs.realpathSync(tempRoot);
  assert.equal(path.dirname(resolvedRoot), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolvedRoot).startsWith('codex-hud-bounded-read-'));
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
}
