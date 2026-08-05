import assert from 'node:assert/strict';

import {
  renderToolsLine,
  cycleToolDetailsMode,
} from '../../dist/render/lines/activity-line.js';

process.env.CODEX_HUD_TOOL_DETAILS = 'targets';

const toolActivity = {
  recentCalls: [
    {
      id: 'call-1',
      name: 'exec_command',
      status: 'completed',
      timestamp: new Date(0),
    },
  ],
  totalCalls: 1,
  callsByType: {},
  lastUpdateTime: new Date(0),
};

assert.ok(
  renderToolsLine(toolActivity) !== null,
  'the initial env-seeded targets mode renders the tools line'
);

assert.equal(cycleToolDetailsMode(), 'full', 'targets cycles to full');
assert.ok(renderToolsLine(toolActivity) !== null, 'full mode renders');

assert.equal(cycleToolDetailsMode(), 'off', 'full cycles to off');
assert.equal(
  renderToolsLine(toolActivity),
  null,
  'off mode hides the tools line'
);

assert.equal(cycleToolDetailsMode(), 'targets', 'off wraps back to targets');
assert.ok(
  renderToolsLine(toolActivity) !== null,
  'targets renders again after a full cycle'
);

// The runtime override outlives later environment changes.
process.env.CODEX_HUD_TOOL_DETAILS = 'off';
assert.ok(
  renderToolsLine(toolActivity) !== null,
  'a runtime override takes precedence over the environment variable'
);

console.log('test-tool-details-cycle: PASS');
