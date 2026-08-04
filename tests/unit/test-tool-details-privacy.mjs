import assert from 'node:assert/strict';

import { renderToolsLine } from '../../dist/render/lines/activity-line.js';
import { stripAnsi } from '../../dist/render/colors.js';

const toolActivity = {
  recentCalls: [
    {
      id: 'exec-1',
      name: 'exec_command',
      status: 'running',
      timestamp: new Date(Date.now() - 1000),
      summary: 'curl -H "Authorization: Bearer secret" https://internal.test',
      target: 'curl -H "Authorization: Bearer secret" https://internal.test',
      workdir: '/tmp/private-project',
    },
  ],
  totalCalls: 1,
  callsByType: { exec_command: 1 },
  lastUpdateTime: new Date(),
};

delete process.env.CODEX_HUD_TOOL_DETAILS;
const defaultLine = stripAnsi(renderToolsLine(toolActivity, 120) ?? '');
// targets mode shows the command head (program name), never arguments —
// even when a raw command leaks into `target`, only the head may render.
assert.match(defaultLine, /exec_command: curl/);
assert.doesNotMatch(defaultLine, /Authorization|internal\.test|secret|-H/);

process.env.CODEX_HUD_TOOL_DETAILS = 'full';
const fullLine = stripAnsi(renderToolsLine(toolActivity, 120) ?? '');
assert.match(fullLine, /Authorization/);

process.env.CODEX_HUD_TOOL_DETAILS = 'off';
assert.equal(renderToolsLine(toolActivity, 120), null);

console.log('test-tool-details-privacy: PASS');
