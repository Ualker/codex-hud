import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseRolloutFile } from '../../dist/collectors/rollout.js';
import { renderToolsLine, renderTodosLine } from '../../dist/render/lines/index.js';
import { stripAnsi } from '../../dist/render/colors.js';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-code-mode-'));

// codex-cli 0.147 runs every tool through a single `exec` custom tool whose
// input is a JavaScript program. Protocol-level tool names collapsed to `exec`
// and `wait`, and the arguments stopped being JSON, so the HUD recovered no
// command, no working directory, no plan, and — because the wrapping script
// reports success whatever the command does — no failures either.
let clock = Date.parse('2026-08-13T10:00:00.000Z');
const at = (stepMs = 1000) => new Date((clock += stepMs)).toISOString();

const lines = [];
const push = (entry) => lines.push(JSON.stringify(entry));

push({
  timestamp: at(0),
  type: 'session_meta',
  payload: {
    id: '019ff4e2-a2b5-7352-9076-a7e8e9dc2ecc',
    timestamp: at(0),
    cwd: '/Users/dev/prj',
    originator: 'codex-tui',
    cli_version: '0.147.0',
    source: 'cli',
  },
});

const execCall = (callId, input) => ({
  timestamp: at(),
  type: 'response_item',
  payload: { type: 'custom_tool_call', call_id: callId, name: 'exec', input },
});

const commandExecution = (cmd, exitCode) => ({
  timestamp: at(),
  type: 'event_msg',
  payload: {
    type: 'item_completed',
    item: {
      type: 'CommandExecution',
      id: `exec-${cmd.length}-${exitCode}`,
      command: ['/bin/zsh', '-lc', cmd],
      cwd: 'file:///Users/dev/prj',
      parsed_cmd: [{ type: 'unknown', cmd }],
      exit_code: exitCode,
      status: exitCode === 0 ? 'completed' : 'failed',
    },
  },
});

const output = (callId, text = 'Script completed\nWall time 0.4 seconds\nOutput:\n') => ({
  timestamp: at(),
  type: 'response_item',
  payload: {
    type: 'custom_tool_call_output',
    call_id: callId,
    output: [{ type: 'input_text', text }],
  },
});

// 1. One command, argument written as a JS object literal.
push(execCall('c1', 'const r = await tools.exec_command({cmd: "npm test", workdir: "/Users/dev/prj"});'));
push(commandExecution('npm test', 0));
push(output('c1'));

// 2. A command that fails. The script around it still "completes".
push(execCall('c2', 'const r = await tools.exec_command({cmd: "node server.mjs"});'));
push(commandExecution('node server.mjs', 1));
push(output('c2'));

// 3. A plan.
push(execCall('c3', `await tools.update_plan({
  plan: [
    { step: "read the parser", status: "completed" },
    { step: "fix the row", status: "in_progress" },
    { step: "write the test", status: "pending" },
  ]
});`));
push(output('c3'));

// 4. A patch applied through a variable.
push(execCall('c4', 'const patch = "*** Begin Patch\\n*** Update File: /Users/dev/prj/src/row.ts\\n@@\\n-a\\n+b\\n*** End Patch";\nawait tools.apply_patch(patch);'));
push(output('c4'));

const file = path.join(tempRoot, 'rollout-2026-08-13T10-00-00-019ff4e2.jsonl');
fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');

const { result } = await parseRolloutFile(file, 0);
const byId = new Map(result.toolActivity.recentCalls.map((c) => [c.id, c]));

// ---- the command comes back ----------------------------------------------
{
  const call = byId.get('c1');
  assert.equal(call.name, 'exec_command', 'the inner tool names the call');
  assert.equal(call.summary, 'npm test', 'the command is recovered from the JS literal');
  assert.equal(call.target, 'npm test');
  assert.equal(call.workdir, '/Users/dev/prj');
  assert.equal(call.status, 'completed');
}

// ---- a failed command reads as failed -------------------------------------
// The output envelope says the script completed; only the command record
// carries the exit code, so a HUD reading the envelope alone showed ✓.
{
  const call = byId.get('c2');
  assert.equal(call.status, 'error', 'a non-zero exit inside the script is a failure');
  assert.equal(call.result.exitCode, 1);
  assert.equal(call.summary, 'node server.mjs');
}

// ---- the plan row exists again --------------------------------------------
{
  assert.ok(result.planProgress, 'update_plan through `exec` still sets the plan');
  assert.equal(result.planProgress.totalSteps, 3);
  assert.equal(result.planProgress.completedSteps, 1);
  const row = stripAnsi(renderTodosLine(result.planProgress, 146));
  assert.match(row, /1\/3/);
  assert.match(row, /fix the row/, 'the step in progress is named');
}

// ---- an edited file is named ----------------------------------------------
{
  const call = byId.get('c4');
  assert.equal(call.name, 'apply_patch');
  assert.match(call.summary, /row\.ts/, 'the patch target survives being passed by variable');
}

// ---- and the row a user sees says all of it -------------------------------
{
  const row = stripAnsi(renderToolsLine(result.toolActivity, 146, clock, false));
  assert.match(row, /✗/, 'the failure is visible without opening anything');
  assert.match(row, /node server\.mjs|exit 1/);
  assert.match(row, /npm test/, 'and successful commands are named too');
}

// ---- attribution: a poll is not the thing it polled -----------------------
// `wait` sits open while a command started earlier finishes, so the command
// record lands during it. The exit code is still the wait's outcome; the
// command text belongs to the call that ran it.
{
  const waitLines = [lines[0]];
  const pushWait = (entry) => waitLines.push(JSON.stringify(entry));
  pushWait({
    timestamp: at(),
    type: 'response_item',
    payload: {
      type: 'function_call',
      call_id: 'w1',
      name: 'wait',
      arguments: JSON.stringify({ cell_id: 57, yield_time_ms: 20000 }),
    },
  });
  pushWait(commandExecution('git diff --no-index a b', 1));
  pushWait({
    timestamp: at(),
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: 'w1', output: 'done' },
  });

  const waitFile = path.join(tempRoot, 'rollout-2026-08-13T11-00-00-019ff4e3.jsonl');
  fs.writeFileSync(waitFile, waitLines.join('\n') + '\n', 'utf8');
  const parsed = (await parseRolloutFile(waitFile, 0)).result;
  const call = parsed.toolActivity.recentCalls.find((c) => c.id === 'w1');
  assert.equal(call.status, 'error', 'the awaited cell failed, so the wait failed');
  assert.equal(call.result.exitCode, 1);
  assert.equal(
    call.target,
    undefined,
    'but `wait` did not run git diff and must not be labelled with it'
  );
  assert.match(stripAnsi(renderToolsLine(parsed.toolActivity, 146, clock, false)), /cell 57/);
}

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log('test-rollout-code-mode: PASS');
