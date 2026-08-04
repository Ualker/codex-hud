import assert from 'node:assert/strict';

import { parseRolloutFile } from '../../dist/collectors/rollout.js';
import {
  canonicalSessionMeta,
  cleanupAgentTestRoot,
  makeAgentTestRoot,
  writeRolloutFile,
} from '../helpers/agent-rollout-fixture.mjs';

const root = makeAgentTestRoot();

function functionCall(timestamp, callId, name, args) {
  return {
    timestamp,
    type: 'response_item',
    payload: {
      type: 'function_call',
      call_id: callId,
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function functionOutput(timestamp, callId, output) {
  return {
    timestamp,
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: callId,
      output,
    },
  };
}

try {
  const secretCommand = [
    'OPENAI_API_KEY=sk-secret-value',
    'curl --token top-secret-token',
    '-H "Authorization: Bearer header-secret"',
    '-H "X-API-Key: x-header-secret"',
    'https://alice:hunter2@example.test/path',
    '\u001b[31m\u202e',
    '\nprintf ok',
  ].join(' ');
  const records = [
    canonicalSessionMeta({
      id: '019a7777-f777-7ff7-8777-777777777777',
      cwd: '/tmp/codex-hud-agent-project',
    }),
    functionCall(
      '2026-07-12T00:00:01.000Z',
      'call_exit_error',
      'exec_command',
      {
        cmd: secretCommand,
        workdir: '/tmp/codex-hud-agent-project',
        yield_time_ms: 10000,
      }
    ),
    functionOutput(
      '2026-07-12T00:00:02.000Z',
      'call_exit_error',
      [
        'Chunk ID: exit007',
        'Wall time: 1.2500 seconds',
        'Process exited with code 7',
        'Original token count: 12',
        'Output:',
        'user stdout says Process exited with code 0',
      ].join('\n')
    ),
    functionCall(
      '2026-07-12T00:00:03.000Z',
      'call_yielded',
      'exec_command',
      {
        cmd: 'npm test',
        workdir: '/tmp/codex-hud-agent-project',
      }
    ),
    functionOutput(
      '2026-07-12T00:00:04.000Z',
      'call_yielded',
      [
        'Chunk ID: yield42',
        'Wall time: 30.0000 seconds',
        'Process running with session ID 4242',
        'Original token count: 4',
        'Output:',
      ].join('\n')
    ),
    functionCall(
      '2026-07-12T00:00:05.000Z',
      'call_poll',
      'write_stdin',
      {
        session_id: '4242\u001b[31m',
        chars: '',
        yield_time_ms: 10000,
      }
    ),
    functionOutput(
      '2026-07-12T00:00:06.000Z',
      'call_poll',
      [
        'Chunk ID: poll42',
        'Wall time: 10.0000 seconds',
        'Process running with session ID 4242',
        'Original token count: 0',
        'Output:',
      ].join('\n')
    ),
    {
      timestamp: '2026-07-12T00:00:07.000Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: 'call_patch',
        name: 'apply_patch',
        input: [
          '*** Begin Patch',
          '*** Update File: /tmp/repo/src/first.ts',
          '@@',
          '-old',
          '+new',
          '*** Add File: /tmp/repo/src/second.ts',
          '+content',
          '*** End Patch',
        ].join('\n'),
      },
    },
    {
      timestamp: '2026-07-12T00:00:07.100Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'call_patch',
        output: 'Done!',
      },
    },
    {
      timestamp: '2026-07-12T00:00:08.000Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: 'call_custom_json_exec',
        name: 'exec',
        input: [
          'const result = await tools.exec_command(',
          '{"cmd":"git status --short","workdir":"/tmp/repo"}',
          ');',
          'text(result.output);',
        ].join(''),
      },
    },
    {
      timestamp: '2026-07-12T00:00:08.200Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'call_custom_json_exec',
        output: [
          {
            type: 'input_text',
            text: 'Script completed\nWall time: 0.2000 seconds\nOutput:\n',
          },
          { type: 'input_text', text: 'clean\n' },
        ],
      },
    },
    functionCall(
      '2026-07-12T00:00:08.300Z',
      'call_exit_without_wall_time',
      'exec_command',
      { cmd: 'false', workdir: '/tmp/repo' }
    ),
    functionOutput(
      '2026-07-12T00:00:08.400Z',
      'call_exit_without_wall_time',
      [
        'Chunk ID: no-wall-time',
        'Process exited with code 2',
        'Original token count: 0',
        'Output:',
      ].join('\n')
    ),
    functionCall(
      '2026-07-12T00:00:09.000Z',
      'call_unknown_envelope',
      'exec_command',
      { cmd: 'printf done', workdir: '/tmp/repo' }
    ),
    functionOutput(
      '2026-07-12T00:00:09.100Z',
      'call_unknown_envelope',
      'command output without a recognized metadata envelope'
    ),
  ];

  const rolloutPath = writeRolloutFile(root, {
    sessionId: '019a7777-f777-7ff7-8777-777777777777',
    timestampLabel: '2026-07-12T00-07-00',
    records,
  });
  const { result, runningCalls } = await parseRolloutFile(rolloutPath, 0, 20);
  const calls = Object.fromEntries(
    result.toolActivity.recentCalls.map((call) => [call.id, call])
  );

  assert.equal(runningCalls.size, 0);

  const failed = calls.call_exit_error;
  assert.equal(failed.status, 'error');
  assert.deepEqual(failed.result, {
    kind: 'exited',
    exitCode: 7,
    wallTimeMs: 1250,
  });
  assert.equal(failed.duration, 1000);
  assert.equal(failed.workdir, '/tmp/codex-hud-agent-project');
  assert.match(failed.summary, /OPENAI_API_KEY=\*\*\*/);
  assert.match(failed.summary, /--token \*\*\*/);
  assert.match(failed.summary, /Authorization: \*\*\*/);
  assert.match(failed.summary, /https:\/\/\*\*\*:\*\*\*@example\.test/);
  assert.doesNotMatch(
    failed.summary,
    /sk-secret-value|top-secret-token|header-secret|x-header-secret|hunter2/
  );
  assert.doesNotMatch(failed.summary, /\u001b|\u202e|\r|\n/);

  // target carries only the privacy-preserving command head.
  assert.match(failed.target, /^curl/);
  assert.doesNotMatch(
    failed.target,
    /sk-secret-value|top-secret-token|header-secret|hunter2|Authorization|--token/
  );

  const yielded = calls.call_yielded;
  assert.equal(yielded.status, 'completed');
  assert.deepEqual(yielded.result, {
    kind: 'yielded',
    sessionId: '4242',
    wallTimeMs: 30000,
  });
  assert.equal(yielded.summary, 'npm test');
  assert.equal(yielded.target, 'npm test');

  const poll = calls.call_poll;
  assert.equal(poll.summary, 'poll session 4242');
  assert.equal(poll.target, 'poll session 4242');
  assert.deepEqual(poll.result, {
    kind: 'yielded',
    sessionId: '4242',
    wallTimeMs: 10000,
  });

  const patch = calls.call_patch;
  assert.equal(patch.status, 'completed');
  assert.equal(patch.summary, '2 files: first.ts, second.ts');
  assert.equal(patch.target, undefined);

  const customExec = calls.call_custom_json_exec;
  assert.equal(customExec.name, 'exec_command');
  assert.equal(customExec.summary, 'git status --short');
  assert.equal(customExec.target, 'git status');
  assert.equal(customExec.workdir, '/tmp/repo');
  assert.deepEqual(customExec.result, {
    kind: 'completed',
    wallTimeMs: 200,
  });

  const noWallTime = calls.call_exit_without_wall_time;
  assert.equal(noWallTime.status, 'error');
  assert.deepEqual(noWallTime.result, {
    kind: 'exited',
    exitCode: 2,
  });

  const unknown = calls.call_unknown_envelope;
  assert.equal(unknown.status, 'completed');
  assert.deepEqual(unknown.result, { kind: 'unknown' });

  // An aborted turn must not leave tools spinning as "running" forever.
  const abortRecords = [
    canonicalSessionMeta({
      id: '019a8888-f888-7ff8-8888-888888888888',
      cwd: '/tmp/codex-hud-agent-project',
    }),
    functionCall(
      '2026-07-12T00:01:00.000Z',
      'call_interrupted',
      'exec_command',
      { cmd: 'sleep 100', workdir: '/tmp/repo' }
    ),
    {
      timestamp: '2026-07-12T00:01:05.000Z',
      type: 'event_msg',
      payload: { type: 'turn_aborted', turn_id: 'turn-abort-1' },
    },
  ];
  const abortRolloutPath = writeRolloutFile(root, {
    sessionId: '019a8888-f888-7ff8-8888-888888888888',
    timestampLabel: '2026-07-12T00-08-00',
    records: abortRecords,
  });
  const abortParse = await parseRolloutFile(abortRolloutPath, 0, 20);
  assert.equal(
    abortParse.runningCalls.size,
    0,
    'turn_aborted clears running calls'
  );
  const interrupted = abortParse.result.toolActivity.recentCalls.find(
    (call) => call.id === 'call_interrupted'
  );
  assert.equal(interrupted.status, 'error');
  assert.equal(interrupted.duration, 5000);

  console.log('test-tool-execution-details: PASS (exit, yield, redact, patch, custom, abort)');
} finally {
  cleanupAgentTestRoot(root);
}
