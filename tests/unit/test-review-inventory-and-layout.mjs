import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectCodexAssetBreakdown } from '../../dist/collectors/codex-assets.js';
import { readCodexConfigStrict } from '../../dist/collectors/codex-config.js';
import { renderEnvironmentLine } from '../../dist/render/lines/environment-line.js';
import { renderHud } from '../../dist/render/header.js';
import { stripAnsi, getSpinnerFrame, advanceSpinnerFrame } from '../../dist/render/colors.js';
import { moveSelection } from '../../dist/ui/state.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-inventory-layout-'));
const oldHome = process.env.CODEX_HOME;
try {
  const cwd = path.join(root, 'repo');
  const home = path.join(root, 'user');
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  const writeSkill = (file, name) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\nname: ${name}\ndescription: Fixture ${name}\n---\n`);
  };
  const disabled = path.join(codexHome, 'skills', 'disabled', 'SKILL.md');
  const userSkill = path.join(home, '.agents', 'skills', 'user', 'SKILL.md');
  writeSkill(disabled, 'disabled');
  writeSkill(userSkill, 'user');
  writeSkill(path.join(cwd, '.agents', 'skills', 'repo', 'SKILL.md'), 'repo');
  fs.symlinkSync(path.dirname(userSkill), path.join(codexHome, 'skills', 'alias'));
  fs.writeFileSync(path.join(codexHome, 'config.toml'), `approval_policy="on-request"\nsandbox_mode="workspace-write"\n[[skills.config]]\npath=${JSON.stringify(disabled)}\nenabled=false\n`);
  process.env.CODEX_HOME = codexHome;
  const config = readCodexConfigStrict();
  const counts = await collectCodexAssetBreakdown(cwd, { HOME: home, CODEX_HOME: codexHome, CODEX_ADMIN_SKILLS_DIR: path.join(root, 'admin') }, config);
  assert.equal(counts.codexSkillsCount, 2, 'user and repository .agents skills are enabled, disabled legacy skill excluded');
  assert.equal(counts.installedSkillsCount, 3, 'symlink aliases never double count');
  assert.equal(counts.otherAgentSkillsCount, 0);

  const data = { config, git: { isGitRepo: false }, project: { cwd, projectName: 'Fixture', skillsCount: 2, installedSkillsCount: 3 },
    sessionStart: new Date(), session: { id: 'fixture', title: 'Current task', cwd, startTime: new Date() },
    boundWithoutRollout: true, paneCliPolicy: { exhaustive: true },
    contextUsage: { used: 95000, total: 100000, percent: 95 },
    turnActivity: { phase: 'awaiting-approval', since: new Date(), lastActivityAt: new Date() },
    agentActivity: { visibleAgentCount: 6, rows: Array.from({ length: 6 }, (_, i) => ({ threadId: `${i}`, agentPath: `/root/a${i}`, label: `Agent ${i}`, status: 'running', activeDescendantCount: 0, elapsedStartedAt: new Date() })) },
  };
  assert.match(stripAnsi(renderEnvironmentLine(data, 160)), /Approval: \?.*Sandbox: \?/);
  const oldDetails = process.env.CODEX_HUD_DETAILS;
  process.env.CODEX_HUD_DETAILS = 'full';
  assert.match(stripAnsi(renderEnvironmentLine({ ...data, project: { ...data.project, skillsCount: 0 } }, 200)),
    /Skills enabled: 0\/3/, 'an entirely disabled inventory remains visible');
  if (oldDetails === undefined) delete process.env.CODEX_HUD_DETAILS; else process.env.CODEX_HUD_DETAILS = oldDetails;
  const narrow = renderHud({ ...data, layoutPreset: 'coexist', session: { ...data.session, sandboxMode: 'danger-full-access' } },
    { width: 20, maxLines: 5, reservedRow1Width: 7 });
  assert.match(stripAnsi(narrow[0]), /\[FULL ACCESS\]/, 'even a tiny title budget keeps the full-access badge intact');
  for (const preset of ['standard', 'coexist']) for (const height of [5, 8, 12]) {
    const lines = renderHud({ ...data, layoutPreset: preset }, { width: 120, maxLines: height, showDetails: true });
    const visible = lines.slice(0, height).map(stripAnsi).join('\n');
    assert.match(visible, /Ctx:.*5% left/, `${preset}/${height}: high context pressure must survive agents`);
    assert.match(visible, /[Aa]pproval/, `${preset}/${height}: approval must remain actionable`);
  }
  process.env.CODEX_HUD_ANIMATION = '0';
  const still = getSpinnerFrame();
  advanceSpinnerFrame(); advanceSpinnerFrame();
  assert.equal(getSpinnerFrame(), still);
  delete process.env.CODEX_HUD_ANIMATION;
  const rows = [{ id: 'a', tmuxSession: 'hud-a' }, { id: 'read-only' }, { id: 'b', tmuxSession: 'hud-b' }];
  assert.equal(moveSelection(rows, 'a', 1), 'b');
  assert.equal(moveSelection([{ id: 'read-only' }], undefined, 1), undefined);
  console.log('test-review-inventory-and-layout: PASS');
} finally {
  if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
  fs.rmSync(root, { recursive: true, force: true });
}
