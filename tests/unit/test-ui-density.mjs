import assert from 'node:assert/strict';

import { renderHud } from '../../dist/render/header.js';
import { renderTokenLine, cycleToolDetailsMode } from '../../dist/render/lines/activity-line.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';

const now = Date.now();
const data = {
  config: { model: 'gpt-6-astra', sandbox_mode: 'danger-full-access', approval_policy: 'never' },
  git: { isGitRepo: false },
  project: { cwd: '/work/project', projectName: 'project', mcpCount: 6, skillsCount: 20, hooksCount: 4 },
  session: { id: 'session-1234', model: 'gpt-6-astra', reasoningEffort: 'max', startTime: new Date(now),
    title: '修复布局并检查窄窗口下的操作按钮' },
  partialHistory: true,
  runtimeStateComplete: true,
  contextUsage: { used: 71_093, total: 258_400, percent: 28, compactCount: 123 },
  turnActivity: { phase: 'awaiting-approval', since: new Date(now), lastActivityAt: new Date(now) },
};
const layout = { mode: 'expanded', showSeparators: false, showDuration: true, showContextBreakdown: true, barWidth: 12 };

// Numeric capacity and compactions outrank the gauge and its token equivalent.
// Cover the entire interval: testing only common breakpoints missed elision
// between them when a gauge grew by a cell.
for (let width = 24; width <= 180; width++) {
  const text = stripAnsi(renderTokenLine(data, width));
  assert.match(text, /72% left/, `${width}: capacity stays readable`);
  assert.match(text, /↻≥123/, `${width}: compactions survive before decoration`);
  assert.ok(visualLength(text) <= width, `${width}: no wrapping`);
}

// Rendering a crowded heading must still reserve the actual view control.
for (const width of [40, 48, 60, 80, 100, 140]) {
  const lines = renderHud({ ...data, session: { ...data.session, model: 'a-long-model-name-with-effort' } }, {
    width, maxLines: 4, showDetails: true, layout, reservedRow1Width: 40,
  }).map(stripAnsi);
  assert.ok(visualLength(lines[0]) <= width - 7, `${width}: heading leaves the button reachable`);
  assert.match(lines.join('\n'), /FULL ACCESS/);
  assert.match(lines.slice(0, 4).join('\n'), /Approval needed/);
  assert.match(lines.slice(0, 4).join('\n'), /↻≥123/);
}

const frame = () => renderHud(data, { width: 180, maxLines: 12, showDetails: true, layout }).map(stripAnsi).join('\n');
assert.doesNotMatch(frame(), /MCP:|MCP configured:|Skills:|Codex skills:|Hooks:/,
  'the default view keeps effective permissions without installed inventory');
cycleToolDetailsMode(now); // targets -> full
assert.match(frame(), /MCP configured: 6.*Codex skills: 20.*Hooks: 4/,
  'existing full-details control still exposes the complete inventory');

console.log('test-ui-density: PASS');
