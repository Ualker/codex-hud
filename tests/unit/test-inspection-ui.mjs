import assert from 'node:assert/strict';
import { renderHud } from '../../dist/render/header.js';
import { visualLength, stripAnsi } from '../../dist/render/colors.js';
const target = 'codex-hud-project-with-a-long-name-12345678-20261106120000-12345';
const data = { config: {}, git: { isGitRepo: false }, project: { cwd: '/tmp/project', projectName: 'project' },
  sessionStart: new Date(), inspectionVisible: true, hudSession: target,
  bindingInfo: { source: 'unbound', error: 'Rollout unavailable' },
  collectorHealth: { rollout: { status: 'error', errorSummary: 'Cannot read session log' } },
};
for (const width of [28, 60, 120]) {
  const pages = Array.from({ length: 20 }, (_, inspectionPage) => renderHud({ ...data, inspectionPage }, { width, maxLines: 5, showDetails: true }));
  assert.ok(pages.every(rows => rows.length <= 5 && rows.every(row => visualLength(row) <= width)));
  const contents = pages.flatMap(rows => rows.slice(1, -1)).map(stripAnsi).join('');
  assert.ok(contents.includes(target), 'full target remains recoverable across wrapped pages');
  assert.match(contents, /Cannot read session log/);
  assert.match(contents, /codex-hud --doctor --json/);
}
const overview = { ...data, inspectionVisible: false, displayMode: 'overview', overviewSelectionId: 'selected',
  overview: { sessions: [{ id: 'selected', tmuxSession: target, title: 'Fix important failure', projectName: 'project',
    turnActivity: { phase: 'failed' } }], updatedAt: new Date() } };
overview.overview.sessions[0].tmuxPane = '%42';
const selected = renderHud(overview, { width: 100, maxLines: 5, showDetails: true }).find(row => stripAnsi(row).includes('> '));
assert.ok(stripAnsi(selected).includes('%42'), 'compact address is a complete actionable pane ID');
assert.ok(selected.includes('\x1b[4m'), 'selection is underlined');
assert.ok(/\x1b\[(?:31|91|38;2;[^m]+)m/.test(selected), 'failure retains its semantic color');
assert.ok(!selected.includes('\x1b[7m'), 'selection does not erase semantic colors');
console.log('test-inspection-ui: PASS');
