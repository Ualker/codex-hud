import assert from 'node:assert/strict';

import {
  normalizeCustomToolName,
  parseRolloutFile,
  RolloutParser,
} from '../../dist/collectors/rollout.js';
import {
  appendRolloutRecords,
  canonicalSessionMeta,
  cleanupAgentTestRoot,
  makeAgentTestRoot,
  writeRolloutFile,
} from '../helpers/agent-rollout-fixture.mjs';

const root = makeAgentTestRoot();

try {
  const singleInvocation = `
    const quoted = "tools.fake()";
    // tools.commentOnly()
    const template = \`tools.templateOnly()\`;
    const result = await tools.exec_command({ cmd: "pwd" });
    text(result.output);
  `;

  assert.equal(
    normalizeCustomToolName('exec', singleInvocation),
    'exec_command',
    'one unambiguous nested invocation should use its concrete name'
  );
  assert.equal(
    normalizeCustomToolName(
      'exec',
      'const a = await tools.exec_command({ cmd: "pwd" }); await tools.update_plan({ plan: [] });'
    ),
    'exec',
    'multiple nested invocations should retain the top-level name'
  );
  assert.equal(
    normalizeCustomToolName('exec', 'text("no nested tool");'),
    'exec',
    'missing nested invocations should retain the top-level name'
  );
  assert.equal(
    normalizeCustomToolName('imagegen', 'await tools.exec_command({ cmd: "pwd" });'),
    'imagegen',
    'non-exec custom tools should retain their protocol name'
  );

  const mixedPath = writeRolloutFile(root, {
    sessionId: '019a4444-d444-7dd4-8444-444444444444',
    timestampLabel: '2026-07-12T00-03-00',
    records: [
      canonicalSessionMeta({ id: '019a4444-d444-7dd4-8444-444444444444' }),
      {
        timestamp: '2026-07-12T00:03:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call_legacy_read',
          name: 'read',
          arguments: '{"file_path":"README.md"}',
        },
      },
      {
        timestamp: '2026-07-12T00:03:01.100Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_legacy_read',
          output: { success: true },
        },
      },
      {
        timestamp: '2026-07-12T00:03:02.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          id: 'ctc_exec_item',
          call_id: 'call_custom_exec',
          name: 'exec',
          status: 'completed',
          input: singleInvocation,
        },
      },
      {
        timestamp: '2026-07-12T00:03:02.250Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call_custom_exec',
          output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds' }],
        },
      },
      {
        timestamp: '2026-07-12T00:03:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call_wait',
          name: 'wait',
          arguments: '{"cell_id":"fixture"}',
        },
      },
      {
        timestamp: '2026-07-12T00:03:03.100Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_wait',
          output: { success: true },
        },
      },
      {
        timestamp: '2026-07-12T00:03:04.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'call_multi_exec',
          name: 'exec',
          input: 'await tools.exec_command({ cmd: "pwd" }); await tools.apply_patch("*** Begin Patch");',
        },
      },
      {
        timestamp: '2026-07-12T00:03:04.500Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call_multi_exec',
          output: [{ type: 'input_text', text: 'Script failed\nSyntaxError: fixture' }],
        },
      },
    ],
  });

  const mixed = await parseRolloutFile(mixedPath, 0, 10);

  assert.equal(mixed.result.toolActivity.totalCalls, 4);
  assert.deepEqual(mixed.result.toolActivity.callsByType, {
    read: 1,
    exec_command: 1,
    wait: 1,
    exec: 1,
  });
  assert.deepEqual(
    mixed.result.toolActivity.recentCalls.map(({ id, name, status, target }) => ({
      id,
      name,
      status,
      target,
    })),
    [
      { id: 'call_legacy_read', name: 'read', status: 'completed', target: 'README.md' },
      { id: 'call_custom_exec', name: 'exec_command', status: 'completed', target: undefined },
      { id: 'call_wait', name: 'wait', status: 'completed', target: undefined },
      { id: 'call_multi_exec', name: 'exec', status: 'error', target: undefined },
    ]
  );
  assert.equal(mixed.runningCalls.size, 0);

  const scriptErrorPath = writeRolloutFile(root, {
    sessionId: '019a4666-d466-7dd6-8466-444444444466',
    timestampLabel: '2026-07-12T00-03-30',
    records: [
      canonicalSessionMeta({ id: '019a4666-d466-7dd6-8466-444444444466' }),
      {
        timestamp: '2026-07-12T00:03:31.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'call_script_error',
          name: 'exec',
          input: 'const result = await tools.exec_command({ cmd: "false" }); text(result);',
        },
      },
      {
        timestamp: '2026-07-12T00:03:31.100Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call_script_error',
          output: 'Script error: fixture failure',
        },
      },
    ],
  });

  const scriptError = await parseRolloutFile(scriptErrorPath);
  assert.equal(scriptError.result.toolActivity.recentCalls[0].status, 'error');

  const incrementalPath = writeRolloutFile(root, {
    sessionId: '019a5555-e555-7ee5-8555-555555555555',
    timestampLabel: '2026-07-12T00-04-00',
    records: [
      canonicalSessionMeta({ id: '019a5555-e555-7ee5-8555-555555555555' }),
      {
        timestamp: '2026-07-12T00:04:01.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'call_incremental',
          name: 'exec',
          input: 'const result = await tools.update_plan({ plan: [] }); text(result);',
        },
      },
    ],
  });

  const parser = new RolloutParser(10);
  parser.setRolloutPath(incrementalPath);
  const started = await parser.parse();

  assert.equal(started?.toolActivity.totalCalls, 1);
  assert.equal(started?.toolActivity.recentCalls.length, 1);
  assert.equal(started?.toolActivity.recentCalls[0].name, 'update_plan');
  assert.equal(started?.toolActivity.recentCalls[0].status, 'running');

  appendRolloutRecords(incrementalPath, [
    {
      timestamp: '2026-07-12T00:04:02.000Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'call_incremental',
        output: [{ type: 'input_text', text: '{}' }],
      },
    },
  ]);

  const completed = await parser.parse();

  assert.equal(completed?.toolActivity.totalCalls, 1, 'incremental output must not recount the call');
  assert.equal(completed?.toolActivity.recentCalls.length, 1, 'incremental output must not duplicate the call');
  assert.equal(completed?.toolActivity.recentCalls[0].id, 'call_incremental');
  assert.equal(completed?.toolActivity.recentCalls[0].status, 'completed');
  assert.equal(completed?.toolActivity.callsByType.update_plan, 1);

  console.log('test-rollout-custom-tool-call: PASS (parser, normalization, incremental)');
} finally {
  cleanupAgentTestRoot(root);
}
