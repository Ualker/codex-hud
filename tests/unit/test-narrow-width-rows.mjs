import assert from 'node:assert/strict';

import {
  renderEnvironmentLine,
  renderProjectLine,
} from '../../dist/render/lines/index.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';

const data = {
  config: {
    model: 'gpt-5.6-sol',
    sandbox_mode: 'workspace-write',
    approval_policy: 'on-request',
  },
  git: {
    isGitRepo: true,
    branch: 'integrate/upstream-main-20260714',
    isDirty: true,
    ahead: 2,
    behind: 0,
    modified: 3,
    added: 1,
    deleted: 0,
    untracked: 2,
  },
  project: {
    cwd: '/Users/zyb/Desktop/prj',
    projectName: 'prj',
    agentsMdCount: 1,
    rulesCount: 0,
    mcpCount: 6,
    configsCount: 0,
    extensionsCount: 0,
    skillsCount: 17,
    otherAgentSkillsCount: 0,
    hooksCount: 6,
    globalConfigActive: true,
  },
};

const plain = (value) => (value === null ? null : stripAnsi(value));

// ---- the project row keeps the project, not the branch --------------------
// The old order reserved the whole git segment first and spent the remainder
// on the project name, so a 34-character branch survived intact while the
// project decayed to "…" and then vanished. On a narrow pane with several
// sessions open, "which project is this" is the identity the row carries.
{
  for (const width of [55, 45, 35, 25, 15]) {
    const line = plain(renderProjectLine(data, { maxWidth: width }));
    assert.ok(
      visualLength(line) <= width,
      `the row honors its budget at ${width}: ${JSON.stringify(line)}`
    );
    assert.ok(
      line.startsWith('prj'),
      `the project name survives at ${width}: ${JSON.stringify(line)}`
    );
  }

  const at45 = plain(renderProjectLine(data, { maxWidth: 45 }));
  assert.match(at45, /^prj git:\(/, 'the git segment is what shrinks');
  assert.ok(
    at45.includes('…'),
    'and it says so rather than silently dropping trailing markers'
  );

  // Below the point where any branch text fits, the name stands alone.
  const at8 = plain(renderProjectLine(data, { maxWidth: 8 }));
  assert.equal(at8, 'prj', 'a useless git stub is dropped, not padded');

  // The unshrinkable budget still cannot overflow.
  assert.ok(visualLength(plain(renderProjectLine(data, { maxWidth: 1 }))) <= 1);
  assert.equal(renderProjectLine(data, { maxWidth: 0 }), '');
}

// ---- the environment row sheds whole cells instead of half-words ----------
// A 40-column pane used to spend a whole row on
// "Approval: ask for approval | Sandbox: w…" — a half-spelled security state,
// which is worse than a shorter true one.
{
  const wide = plain(renderEnvironmentLine(data, 146));
  assert.match(wide, /Approval: ask for approval/);
  assert.match(wide, /Sandbox: workspace-write/);
  assert.match(wide, /Fast: off/);

  for (const width of [120, 100, 80, 60, 40, 30]) {
    const line = plain(renderEnvironmentLine(data, width));
    if (line === null) {
      continue;
    }
    assert.ok(
      visualLength(line) <= width,
      `the row honors its budget at ${width}`
    );
    assert.equal(
      line.includes('…'),
      false,
      `no cell is cut mid-word at ${width}: ${JSON.stringify(line)}`
    );
  }

  const at60 = plain(renderEnvironmentLine(data, 60));
  assert.match(at60, /Approval: ask for approval/);
  assert.match(at60, /Sandbox: workspace-write/);
  assert.equal(
    at60.includes('Fast:'),
    false,
    'the fast-mode default is the first cell to go'
  );

  const at40 = plain(renderEnvironmentLine(data, 40));
  assert.match(
    at40,
    /Approval: ask for approval/,
    'the approval policy is the last thing standing'
  );

  // Narrower than the shortest true statement: give the row back.
  assert.equal(
    renderEnvironmentLine(data, 12),
    null,
    'an unrenderable row is dropped so the layout can reuse it'
  );
}

// ---- the full-access badge outranks everything it implies -----------------
{
  const fullAccess = {
    ...data,
    config: { ...data.config, sandbox_mode: 'danger-full-access' },
  };
  for (const width of [146, 60, 40, 20, 14]) {
    const line = plain(renderEnvironmentLine(fullAccess, width));
    assert.ok(
      line !== null && line.includes('[FULL ACCESS]'),
      `the badge survives at ${width}: ${JSON.stringify(line)}`
    );
    assert.ok(visualLength(line) <= width);
  }
}

console.log('test-narrow-width-rows: PASS');
