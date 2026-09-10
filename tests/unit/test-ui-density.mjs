import assert from 'node:assert/strict';

import { hudDetailsExpanded, toggleHudDetails } from '../../dist/render/detail-level.js';
import { renderHud } from '../../dist/render/header.js';
import { renderTokenLine, cycleToolDetailsMode, toolDetailsMode } from '../../dist/render/lines/activity-line.js';
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
data.tokenUsage = { last_token_usage: { total_tokens: 70000, input_tokens: 60000 },
  total_token_usage: { total_tokens: 300000 } };
data.toolActivity = { runningCalls: [], recentCalls: [{ id: 'old', name: 'exec_command',
  status: 'error', timestamp: new Date(now - 3600_000), summary: 'old-command', result: { kind: 'exited', exitCode: 1 } }],
  totalCalls: 40, callsByType: {}, lastUpdateTime: new Date(now) };
assert.doesNotMatch(frame(), /Last call:|Total:|Session:|old-command/);
cycleToolDetailsMode(now); // targets -> full
assert.equal(hudDetailsExpanded(), false);
assert.doesNotMatch(frame(), /MCP configured:|Codex skills:|Last call:|Total:|Session:/,
  'tool details never change overall HUD density');
assert.equal(toggleHudDetails(), true);
assert.equal(toolDetailsMode(), 'full');
assert.match(frame(), /MCP configured: 6.*Codex skills: 20.*Hooks: 4/);
assert.match(frame(), /Last call:.*in:/);
assert.match(frame(), /Total:.*300/);
assert.match(frame(), /Session:.*session-1234/);
assert.match(frame(), /old-command/);
assert.equal(toggleHudDetails(), false);

const recentFailure = { ...data.toolActivity.recentCalls[0], timestamp: new Date(now), summary: 'current-failure' };
data.toolActivity.recentCalls.push(recentFailure);
assert.match(frame(), /current-failure/, 'current failures survive the compact view');
data.turnActivity = { ...data.turnActivity, phase: 'idle' };
assert.doesNotMatch(frame(), /current-failure|old-command/, 'idle does not repaint tool history as current trouble');
data.turnActivity = { ...data.turnActivity, phase: 'exited' };
data.toolActivity.runningCalls.push({ id: 'stale', name: 'exec_command', status: 'running', timestamp: new Date(now - 3600_000), summary: 'stale-running' });
assert.match(frame(), /Codex exited/);
assert.doesNotMatch(frame(), /stale-running|tool.*running/, 'confirmed exit removes stale tool spinners');

const crowded = { ...data,
  git: { isGitRepo: true, branch: 'integrate/upstream-main-20260714', ahead: 0, behind: 0 },
  session: { ...data.session, startTime: new Date(now - 3600_000),
    title: '/work/project，修复布局并检查窄窗口下的操作按钮' } };
const heading = renderHud(crowded, { width: 80, maxLines: 8, showDetails: true, layout,
  reservedRow1Width: 7 }).map(stripAnsi)[0];
assert.match(heading, /修复布局/, 'useful task text survives a long branch at 80 columns');
assert.doesNotMatch(heading, /up 1h|\/work\/project/, 'uptime and redundant path yield to the title');
assert.ok(visualLength(heading) <= 73);

console.log('test-ui-density: PASS');
