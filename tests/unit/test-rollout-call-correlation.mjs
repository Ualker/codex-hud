import assert from 'node:assert/strict';
import fs from 'node:fs';

import { parseRolloutFile, RolloutParser } from '../../dist/collectors/rollout.js';
import {
  canonicalSessionMeta,
  cleanupAgentTestRoot,
  makeAgentTestRoot,
  writeRolloutFile,
} from '../helpers/agent-rollout-fixture.mjs';

const root = makeAgentTestRoot();

try {
  const distinctIdsPath = writeRolloutFile(root, {
    sessionId: '019a1111-a111-7aa1-8111-111111111111',
    records: [
      canonicalSessionMeta({ id: '019a1111-a111-7aa1-8111-111111111111' }),
      {
        timestamp: '2026-07-12T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          id: 'fc_123',
          call_id: 'call_123',
          name: 'spawn_agent',
          arguments: '{"task_name":"protocol_test"}',
        },
      },
      {
        timestamp: '2026-07-12T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_123',
          output: {
            success: true,
          },
        },
      },
    ],
  });

  const output = await parseRolloutFile(distinctIdsPath);

  assert.equal(output.runningCalls.size, 0);
  assert.equal(output.result.toolActivity.recentCalls.length, 1);
  assert.equal(output.result.toolActivity.recentCalls[0].id, 'call_123');
  assert.equal(output.result.toolActivity.recentCalls[0].status, 'completed');

  const idOnlyPath = writeRolloutFile(root, {
    sessionId: '019a2222-b222-7bb2-8222-222222222222',
    timestampLabel: '2026-07-12T00-01-00',
    records: [
      canonicalSessionMeta({ id: '019a2222-b222-7bb2-8222-222222222222' }),
      {
        timestamp: '2026-07-12T00:01:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          id: 'fc_id_only',
          name: 'read',
          arguments: '{"file_path":"README.md"}',
        },
      },
    ],
  });

  const idOnlyOutput = await parseRolloutFile(idOnlyPath);
  assert.equal(idOnlyOutput.runningCalls.size, 1);
  assert.equal(idOnlyOutput.runningCalls.has('fc_id_only'), true);
  assert.equal(idOnlyOutput.result.toolActivity.recentCalls[0].id, 'fc_id_only');

  const completedIdOnlyPath = writeRolloutFile(root, {
    sessionId: '019a3333-c333-7cc3-8333-333333333333',
    timestampLabel: '2026-07-12T00-02-00',
    records: [
      canonicalSessionMeta({ id: '019a3333-c333-7cc3-8333-333333333333' }),
      {
        timestamp: '2026-07-12T00:02:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          id: 'fc_completed_id_only',
          name: 'read',
          arguments: '{"file_path":"README.md"}',
        },
      },
      {
        timestamp: '2026-07-12T00:02:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'fc_completed_id_only',
          output: {
            success: true,
          },
        },
      },
    ],
  });

  const completedIdOnlyOutput = await parseRolloutFile(completedIdOnlyPath);
  assert.equal(completedIdOnlyOutput.runningCalls.size, 0);
  assert.equal(completedIdOnlyOutput.result.toolActivity.recentCalls.length, 1);
  assert.equal(
    completedIdOnlyOutput.result.toolActivity.recentCalls[0].id,
    'fc_completed_id_only'
  );
  assert.equal(
    completedIdOnlyOutput.result.toolActivity.recentCalls[0].status,
    'completed'
  );

  const correlatedMcpPath = writeRolloutFile(root, {
    sessionId: '019a4444-d444-7dd4-8444-444444444444',
    timestampLabel: '2026-07-12T00-03-00',
    records: [
      canonicalSessionMeta({ id: '019a4444-d444-7dd4-8444-444444444444' }),
      {
        timestamp: '2026-07-12T00:03:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call_correlated_mcp',
          name: 'get_symbols_overview',
          arguments: '{"relative_path":"src/index.ts"}',
        },
      },
      {
        timestamp: '2026-07-12T00:03:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          call_id: 'call_correlated_mcp',
          invocation: {
            server: 'serena',
            tool: 'get_symbols_overview',
            arguments: { relative_path: 'src/index.ts' },
          },
          duration: { secs: 0, nanos: 750000000 },
          result: { Ok: {} },
        },
      },
      {
        timestamp: '2026-07-12T00:03:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_correlated_mcp',
          output: { success: true },
        },
      },
    ],
  });

  const correlatedMcp = await parseRolloutFile(correlatedMcpPath);
  assert.equal(
    correlatedMcp.result.toolActivity.totalCalls,
    1,
    'generic and MCP records for the same call_id should count once'
  );
  assert.deepEqual(
    correlatedMcp.result.toolActivity.callsByType,
    { 'serena/get_symbols_overview': 1 }
  );
  assert.deepEqual(
    correlatedMcp.result.toolActivity.recentCalls.map(
      ({ id, name, status, duration }) => ({ id, name, status, duration })
    ),
    [{
      id: 'call_correlated_mcp',
      name: 'serena/get_symbols_overview',
      status: 'completed',
      duration: 750,
    }]
  );
  assert.equal(correlatedMcp.runningCalls.size, 0);

  const incrementalMcpPath = writeRolloutFile(root, {
    sessionId: '019a5555-e555-7ee5-8555-555555555555',
    timestampLabel: '2026-07-12T00-04-00',
    records: [
      canonicalSessionMeta({ id: '019a5555-e555-7ee5-8555-555555555555' }),
      {
        timestamp: '2026-07-12T00:04:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call_incremental_mcp',
          name: 'get_current_config',
          arguments: '{}',
        },
      },
    ],
  });

  const incrementalMcpParser = new RolloutParser(1);
  incrementalMcpParser.setRolloutPath(incrementalMcpPath);
  const genericMcp = await incrementalMcpParser.parse();
  assert.deepEqual(genericMcp?.toolActivity.callsByType, {
    get_current_config: 1,
  });

  fs.appendFileSync(incrementalMcpPath, [
    {
      timestamp: '2026-07-12T00:04:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'mcp_tool_call_end',
        call_id: 'call_incremental_mcp',
        invocation: {
          server: 'serena',
          tool: 'get_current_config',
          arguments: {},
        },
        duration: { secs: 1, nanos: 0 },
        result: { Ok: {} },
      },
    },
    {
      timestamp: '2026-07-12T00:04:03.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_incremental_mcp',
        output: { success: true },
      },
    },
    {
      timestamp: '2026-07-12T00:04:04.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'call_after_mcp',
        name: 'read',
        arguments: '{"file_path":"README.md"}',
      },
    },
    {
      timestamp: '2026-07-12T00:04:05.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_after_mcp',
        output: { success: true },
      },
    },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');

  const incrementalMcp = await incrementalMcpParser.parse();
  assert.equal(incrementalMcp?.toolActivity.totalCalls, 2);
  assert.deepEqual(
    incrementalMcp?.toolActivity.callsByType,
    {
      'serena/get_current_config': 1,
      read: 1,
    },
    'incremental MCP enrichment should migrate cached counters after recentCalls trimming'
  );
  assert.equal(
    incrementalMcp?.toolActivity.recentCalls[0].id,
    'call_after_mcp',
    'the counter migration must not depend on the MCP call remaining visible'
  );

  console.log('test-rollout-call-correlation: PASS (5/5 cases)');
} finally {
  cleanupAgentTestRoot(root);
}
