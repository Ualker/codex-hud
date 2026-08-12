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
