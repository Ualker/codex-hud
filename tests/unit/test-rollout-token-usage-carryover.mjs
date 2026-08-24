import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RolloutParser } from '../../dist/collectors/rollout.js';

// Cumulative token usage must survive incremental batches that carry no
// token_count. A task_started alone builds a window-only skeleton, and the
// merge used to adopt it wholesale — measured live as the context gauge
// vanishing at 85% used the moment a turn started, permanently when that turn
// was aborted before its first token_count.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-carryover-'));
const rolloutPath = path.join(dir, 'rollout-test.jsonl');

let clockMs = Date.parse('2026-08-21T04:00:00Z');
function record(payload, type = 'event_msg') {
  clockMs += 1000;
  return `${JSON.stringify({
    timestamp: new Date(clockMs).toISOString(),
    type,
    payload,
  })}\n`;
}

function usageInfo(totalTokens) {
  return {
    total_token_usage: {
      input_tokens: totalTokens - 50,
      cached_input_tokens: 0,
      output_tokens: 50,
      total_tokens: totalTokens,
    },
    last_token_usage: {
      input_tokens: totalTokens - 50,
      cached_input_tokens: 0,
      output_tokens: 50,
      total_tokens: totalTokens,
    },
  };
}

let content = '';
function append(chunk) {
  content += chunk;
  fs.writeFileSync(rolloutPath, content);
}

const parser = new RolloutParser(10);
parser.setRolloutPath(rolloutPath);

try {
  // Turn 1 completes with a real token_count; the window arrives only via
  // task_started, exercising the window-preserve path alongside the usage.
  append(
    record(
      {
        id: '01a02279-adb0-7cb0-a401-1850b1b57692',
        timestamp: new Date(clockMs).toISOString(),
        cwd: dir,
        cli_version: '0.149.0',
      },
      'session_meta'
    ) +
      record({ type: 'task_started', model_context_window: 258400, turn_id: 't1' }) +
      record({ type: 'token_count', info: usageInfo(1000) }) +
      record({ type: 'task_complete', turn_id: 't1', duration_ms: 2000 })
  );
  let result = await parser.parse();
  assert.equal(result.tokenUsage?.last_token_usage?.total_tokens, 1000);
  assert.equal(result.tokenUsage?.model_context_window, 258400);
  assert.equal(result.turnActivity?.phase, 'idle');

  // Turn 2 starts in its own incremental batch: no token_count in the batch,
  // only the task_started skeleton. The cached cumulative usage must survive.
  append(record({ type: 'task_started', model_context_window: 258400, turn_id: 't2' }));
  result = await parser.parse();
  assert.equal(
    result.tokenUsage?.last_token_usage?.total_tokens,
    1000,
    'a turn starting must not blank the cumulative usage'
  );
  assert.equal(result.tokenUsage?.model_context_window, 258400);
  assert.equal(result.turnActivity?.phase, 'thinking');

  // The turn is aborted before its first token_count — the live failure mode:
  // nothing will refill the row, so the carried usage is all there is.
  append(record({ type: 'turn_aborted' }));
  result = await parser.parse();
  assert.equal(
    result.tokenUsage?.last_token_usage?.total_tokens,
    1000,
    'an aborted turn must leave the last known usage in place'
  );
  assert.equal(result.turnActivity?.phase, 'aborted');

  // A later token_count still wins over the carried value.
  append(
    record({ type: 'task_started', model_context_window: 258400, turn_id: 't3' }) +
      record({ type: 'token_count', info: usageInfo(2500) })
  );
  result = await parser.parse();
  assert.equal(result.tokenUsage?.last_token_usage?.total_tokens, 2500);

  // A fresh window value in the skeleton supersedes the cached one (models
  // can change mid-session); usage still carries.
  append(record({ type: 'task_started', model_context_window: 400000, turn_id: 't4' }));
  result = await parser.parse();
  assert.equal(result.tokenUsage?.model_context_window, 400000);
  assert.equal(result.tokenUsage?.last_token_usage?.total_tokens, 2500);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('test-rollout-token-usage-carryover: PASS');
