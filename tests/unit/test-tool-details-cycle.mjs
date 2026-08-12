import assert from 'node:assert/strict';

import {
  renderToolsLine,
  cycleToolDetailsMode,
  renderToolDetailsNotice,
} from '../../dist/render/lines/activity-line.js';
import { stripAnsi } from '../../dist/render/colors.js';

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

// Cycling to `off` removes the tool row entirely, and nothing else on screen
// says which key brought it back. A short-lived receipt confirms the mode.
{
  // Past the notices the cycles above already armed on the real clock.
  const at = Date.now() + 60_000;
  assert.equal(
    renderToolDetailsNotice(80, at),
    null,
    'no notice without a recent mode change'
  );

  const mode = cycleToolDetailsMode(at);
  const notice = stripAnsi(renderToolDetailsNotice(80, at + 500));
  assert.ok(notice.includes(mode), 'the notice names the mode just selected');
  assert.match(notice, /press t to cycle/, 'the notice names the key');

  assert.ok(
    renderToolDetailsNotice(80, at + 2999) !== null,
    'the notice stays up long enough to read'
  );
  assert.equal(
    renderToolDetailsNotice(80, at + 3000),
    null,
    'the notice expires instead of occupying the row for good'
  );
}

console.log('test-tool-details-cycle: PASS');
