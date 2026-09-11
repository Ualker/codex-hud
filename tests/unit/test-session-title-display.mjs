import assert from 'node:assert/strict';
import { compactSessionTitle } from '../../dist/render/session-title.js';
import { renderHud } from '../../dist/render/header.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';

const cwd = '/Users/zyb/Desktop/prj';
assert.equal(compactSessionTitle(`${cwd}，修复布局`, cwd), '修复布局');
assert.equal(compactSessionTitle(`${cwd}/codex-hud，检查升级恢复`, cwd), 'codex-hud，检查升级恢复');
assert.equal(compactSessionTitle(`优化下${cwd}/scripts/agent_fleet_monitor.py这个的UI`, cwd),
  '优化下agent_fleet_monitor.py这个的UI');
assert.equal(compactSessionTitle('检查 "/work/has spaces/example.ts" 的类型'), '检查 example.ts 的类型');
assert.equal(compactSessionTitle('比较 https://example.com/a/b 与 /tmp/lib/file.ts'),
  '比较 https://example.com/a/b 与 file.ts');
assert.equal(compactSessionTitle('/work/project-two，修复', '/work/project'), 'project-two，修复');
assert.equal(compactSessionTitle('\x1b[31m/tmp/example.ts\x1b[0m，修复'), 'example.ts，修复');

const names = ['codex-hud', 'AI-web-manager', 'agent_fleet_monitor.py', 'ssh_gpu_monitor.py'];
const titles = names.map((name) => name.endsWith('.py')
  ? `优化下${cwd}/scripts/${name}这个的UI和交互`
  : `${cwd}/${name}，现在从0开始全面检查布局和升级恢复的边界行为`);
const sessions = titles.map((title, index) => ({
  id: `session-${index}`, title, cwd, projectName: 'prj', model: 'gpt-6-astra',
  tmuxSession: `codex-hud-prj-20260911000000-1000${index}`,
  turnActivity: { phase: 'thinking', since: new Date(), lastActivityAt: new Date() },
  contextUsage: { percent: 25 },
}));
const data = { config: {}, project: { cwd, projectName: 'prj' }, git: { isGitRepo: false },
  displayMode: 'overview', overview: { updatedAt: new Date(), sessions } };
const layout = { mode: 'expanded', showSeparators: false, showDuration: false, barWidth: 8 };
for (const width of [40, 60, 80, 140, 180]) {
  const rows = renderHud(data, { width, maxLines: 6, showDetails: true, layout }).map(stripAnsi);
  for (let i = 0; i < rows.length; i++) {
    assert.ok(visualLength(rows[i]) <= width, `${width}: no wrapping`);
    assert.ok(rows[i].includes(`1000${i}`), `${width}: keep the actionable address`);
    assert.ok(!rows[i].includes('/Users/'), `${width}: parent paths do not consume title space`);
    if (width >= 80) assert.ok(rows[i].includes(names[i]), `${width}: distinct task ${rows[i]}`);
  }
}
for (const width of [60, 80, 140]) {
  const row = stripAnsi(renderHud({ ...data, displayMode: 'single', session: sessions[0] },
    { width, maxLines: 6, showDetails: true, layout })[0]);
  assert.match(row, /codex-hud/);
  assert.doesNotMatch(row, /\/Users\//);
  if (width === 140) assert.match(row, /升级恢复/, 'a wide heading uses room beyond the old 32-cell cap');
}
console.log('test-session-title-display: PASS');
