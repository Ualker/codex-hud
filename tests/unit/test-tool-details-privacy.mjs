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

const webLine = stripAnsi(renderToolsLine({
  ...toolActivity,
  recentCalls: [
    {
      id: 'web-1',
      name: 'web__run',
      status: 'running',
      timestamp: new Date(Date.now() - 1000),
      summary: 'site:developers.openai.com/codex hooks',
      target: 'site:developers.openai.com/codex hooks',
    },
  ],
}) ?? '');
assert.match(
  webLine,
  /web__run: site:developers\.openai\.com\/codex hooks/,
  'web searches expose their sanitized query in targets mode'
);

process.env.CODEX_HUD_TOOL_DETAILS = 'full';
const fullLine = stripAnsi(renderToolsLine(toolActivity, 120) ?? '');
assert.match(fullLine, /Authorization/);

process.env.CODEX_HUD_TOOL_DETAILS = 'off';
const offLine = stripAnsi(renderToolsLine(toolActivity, 120));
assert.match(offLine, /1 tool running/);
assert.doesNotMatch(offLine, /exec_command|curl|Authorization|private-project|secret/);
const failed = stripAnsi(renderToolsLine({ ...toolActivity, recentCalls: [{ ...toolActivity.recentCalls[0], status: 'error', result: { kind: 'exited', exitCode: 1 } }] }, 120));
assert.match(failed, /exit 1/);
assert.doesNotMatch(failed, /curl|Authorization|private-project|secret/);

console.log('test-tool-details-privacy: PASS');
