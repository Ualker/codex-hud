import assert from 'node:assert/strict';

import { renderToolsLine } from '../../dist/render/lines/activity-line.js';
import { stripAnsi } from '../../dist/render/colors.js';

function activity(recentCalls, totalCalls = recentCalls.length) {
  return {
    recentCalls,
    totalCalls,
    callsByType: {},
    lastUpdateTime: new Date(0),
  };
}

function call(id, name, status) {
  return {
    id,
    name,
    status,
    timestamp: new Date(0),
  };
}

const completedWaits = Array.from({ length: 10 }, (_, index) =>
  call(`wait-${index}`, 'wait', 'completed')
);

assert.equal(
  renderToolsLine(activity(completedWaits, 21)),
  null,
  'completed wait-only history should not render a stale activity line'
);

const runningWait = stripAnsi(
  renderToolsLine(activity([call('wait-running', 'wait', 'running')])) ?? ''
);
assert.match(runningWait, /wait/, 'a currently running wait should remain visible');

const mixed = stripAnsi(
  renderToolsLine(activity([
    call('exec-1', 'exec_command', 'completed'),
    call('wait-1', 'wait', 'completed'),
    call('wait-2', 'wait', 'completed'),
  ])) ?? ''
);
assert.equal(mixed, '✓ exec_command', 'completed waits should not obscure useful tools');

const capped = stripAnsi(
  renderToolsLine(activity([
    call('exec-2', 'exec_command', 'completed'),
    ...Array.from({ length: 9 }, (_, index) => call(`capped-wait-${index}`, 'wait', 'completed')),
  ], 21)) ?? ''
);
assert.equal(capped, '✓ exec_command | (21 total)');

const failedWait = stripAnsi(
  renderToolsLine(activity([call('wait-error', 'wait', 'error')])) ?? ''
);
assert.match(failedWait, /wait/, 'failed waits should remain visible for diagnosis');

console.log('test-tool-activity-render: PASS (4 cases)');
