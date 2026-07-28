import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FileWatcher } from '../../dist/collectors/file-watcher.js';
import { RolloutParser } from '../../dist/collectors/rollout.js';
import { createParseQueue } from '../../dist/utils/parse-queue.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-runtime-mcp-'));
const rolloutPath = path.join(root, 'rollout-mcp-refresh.jsonl');

function append(entry) {
  fs.appendFileSync(rolloutPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve(Date.now() - started);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(`condition was not met within ${timeoutMs} ms`));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

let watcher;
let pendingParse = Promise.resolve();
try {
  fs.writeFileSync(rolloutPath, '', 'utf8');
  append({
    timestamp: '2026-07-28T14:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: '019f9db5-0000-7000-8000-000000000000',
      timestamp: '2026-07-28T14:00:00.000Z',
      cwd: root,
      originator: 'codex-tui',
      cli_version: '0.145.0',
      source: 'cli',
    },
  });

  const parser = new RolloutParser(5);
  parser.setRolloutPath(rolloutPath);
  const runParse = createParseQueue(() => parser.parse());
  let latest = await runParse();
  let callbackCount = 0;
  watcher = new FileWatcher([rolloutPath], { usePolling: true });
  watcher.onChange(() => {
    callbackCount += 1;
    pendingParse = runParse().then((parsed) => {
      latest = parsed;
    });
    return pendingParse;
  });
  watcher.start();
  await new Promise((resolve) => setTimeout(resolve, 1200));

  append({
    timestamp: '2026-07-28T14:00:01.000Z',
    type: 'event_msg',
    payload: {
      type: 'mcp_tool_call_begin',
      call_id: 'mcp-refresh-1',
      invocation: {
        server: 'context7',
        tool: 'query-docs',
        arguments: { libraryId: '/private/source' },
      },
    },
  });
  const observedRunningMs = await waitFor(
    () => latest?.toolActivity.recentCalls.some(
      (call) => call.id === 'mcp-refresh-1' && call.status === 'running'
    )
  );

  append({
    timestamp: '2026-07-28T14:00:02.000Z',
    type: 'event_msg',
    payload: {
      type: 'mcp_tool_call_end',
      call_id: 'mcp-refresh-1',
      invocation: {
        server: 'context7',
        tool: 'query-docs',
        arguments: { libraryId: '/private/source' },
      },
      duration: { secs: 1, nanos: 0 },
      result: { Ok: { content: [] } },
    },
  });
  const observedCompletedMs = await waitFor(
    () => latest?.toolActivity.recentCalls.some(
      (call) =>
        call.id === 'mcp-refresh-1' &&
        call.status === 'completed' &&
        call.duration === 1000
    )
  );

  assert.equal(latest.toolActivity.totalCalls, 1);
  assert.equal(latest.toolActivity.callsByType['context7/query-docs'], 1);
  assert.equal(
    Object.hasOwn(latest.toolActivity.recentCalls[0], 'arguments'),
    false
  );
  assert.ok(
    callbackCount >= 2,
    `expected begin/end watcher callbacks, got ${callbackCount}`
  );
  console.log(
    `test-runtime-mcp-refresh: PASS (running_ms=${observedRunningMs}, completed_ms=${observedCompletedMs}, callbacks=${callbackCount})`
  );
} finally {
  await watcher?.stop();
  await pendingParse;
  fs.rmSync(root, { recursive: true, force: true });
}
