import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseRolloutFile, RolloutParser } from '../../dist/collectors/rollout.js';

function writeRollout(records) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-mcp-'));
  const file = path.join(root, 'rollout-mcp.jsonl');
  fs.writeFileSync(
    file,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8'
  );
  return { root, file };
}

const { root, file } = writeRollout([
  {
    timestamp: '2026-07-28T14:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: '019f9db5-0000-7000-8000-000000000000',
      timestamp: '2026-07-28T14:00:00.000Z',
      cwd: '/tmp/codex-hud-mcp-fixture',
      originator: 'codex-tui',
      cli_version: '0.145.0',
      source: 'cli',
    },
  },
  {
    timestamp: '2026-07-28T14:00:01.000Z',
    type: 'event_msg',
    payload: {
      type: 'mcp_tool_call_begin',
      call_id: 'mcp-1',
      invocation: {
        server: 'context7',
        tool: 'query-docs',
        arguments: {
          libraryId: '/private/source',
          authorization: 'Bearer must-not-be-retained',
        },
      },
    },
  },
  {
    timestamp: '2026-07-28T14:00:03.000Z',
    type: 'event_msg',
    payload: {
      type: 'mcp_tool_call_end',
      call_id: 'mcp-1',
      invocation: {
        server: 'context7',
        tool: 'query-docs',
        arguments: {
          libraryId: '/private/source',
          authorization: 'Bearer must-not-be-retained',
        },
      },
      duration: { secs: 2, nanos: 500000000 },
      result: { Ok: { content: [] } },
    },
  },
  {
    timestamp: '2026-07-28T14:00:04.000Z',
    type: 'event_msg',
    payload: {
      type: 'mcp_tool_call_end',
      call_id: 'mcp-2',
      invocation: {
        server: 'notion',
        tool: 'fetch',
        arguments: { id: 'private-page-id' },
      },
      result: { Err: { message: 'server unavailable' } },
    },
  },
  {
    timestamp: '2026-07-28T14:00:05.000Z',
    type: 'event_msg',
    payload: {
      type: 'mcp_tool_call_end',
      call_id: 'mcp-sanitized',
      invocation: {
        server: '\u001b[31mserver\nprod',
        tool: 'read\tmemory\u202e',
        arguments: { secret: 'must-not-be-retained' },
      },
      duration: { secs: 1, nanos: 1000000000 },
      result: { Ok: {} },
    },
  },
  {
    timestamp: '2026-07-28T14:00:06.000Z',
    type: 'event_msg',
    payload: {
      type: 'mcp_tool_call_end',
      call_id: 'x'.repeat(513),
      invocation: { server: 'ignored', tool: 'oversized-id', arguments: {} },
      result: { Ok: {} },
    },
  },
]);

try {
  const parsed = await parseRolloutFile(file, 0, 10);
  assert.equal(parsed.result.toolActivity.totalCalls, 3);
  assert.deepEqual(
    parsed.result.toolActivity.recentCalls
      .slice(0, 2)
      .map((call) => [call.name, call.status]),
    [
      ['context7/query-docs', 'completed'],
      ['notion/fetch', 'error'],
    ],
    'MCP server/tool names and result status should be visible'
  );
  assert.equal(parsed.result.toolActivity.recentCalls[0].duration, 2500);
  assert.equal(
    parsed.result.toolActivity.recentCalls[2].duration,
    undefined,
    'invalid nanoseconds should not produce a misleading duration'
  );
  assert.doesNotMatch(
    parsed.result.toolActivity.recentCalls[2].name,
    /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/,
    'MCP display names should not retain terminal or bidi controls'
  );
  assert.ok(
    parsed.result.toolActivity.recentCalls[2].name.length <= 161,
    'MCP display names should remain bounded'
  );
  assert.equal(parsed.runningCalls.size, 0);
  for (const call of parsed.result.toolActivity.recentCalls) {
    assert.equal(
      Object.hasOwn(call, 'arguments'),
      false,
      'raw MCP arguments must not be retained in HUD state'
    );
  }

  const parser = new RolloutParser(10);
  parser.setRolloutPath(file);
  const initial = await parser.parse();
  assert.equal(initial?.toolActivity.totalCalls, 3);

  fs.appendFileSync(file, `${JSON.stringify({
    timestamp: '2026-07-28T14:00:07.000Z',
    type: 'event_msg',
    payload: {
      type: 'mcp_tool_call_end',
      call_id: 'mcp-3',
      invocation: {
        server: 'memory',
        tool: 'search',
        arguments: { query: 'private query' },
      },
      result: { Ok: { content: [] } },
    },
  })}\n`, 'utf8');

  const incremental = await parser.parse();
  assert.equal(
    incremental?.toolActivity.totalCalls,
    4,
    'an incremental MCP end-only event should be observed once'
  );
  assert.equal(
    incremental?.toolActivity.recentCalls.at(-1)?.name,
    'memory/search'
  );
  assert.equal(
    Object.hasOwn(incremental?.toolActivity.recentCalls.at(-1) ?? {}, 'arguments'),
    false
  );

  console.log('test-rollout-mcp: PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
