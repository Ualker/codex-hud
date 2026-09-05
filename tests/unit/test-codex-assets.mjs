import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { collectCodexAssetCounts } from '../../dist/collectors/codex-assets.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-assets-'));
const cwd = path.join(root, 'repo', 'project');
const userSkills = path.join(root, 'user', 'skills');
const systemSkills = path.join(root, 'system', 'skills');
const adminSkills = path.join(root, 'admin', 'skills');
const codexHome = path.join(root, 'user');

function writeSkill(rootDir, dirName, frontmatter) {
  const skillDir = path.join(rootDir, dirName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n# Skill\n`, 'utf8');
  return skillDir;
}

function writeHooks(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ hooks: { event: entries } }), 'utf8');
}

try {
  fs.mkdirSync(cwd, { recursive: true });
  const enabledSkill = writeSkill(userSkills, 'enabled', 'name: enabled\nenabled: true');
  writeSkill(userSkills, 'disabled', 'name: disabled\nenabled: false');
  fs.mkdirSync(path.join(userSkills, 'malformed'), { recursive: true });
  fs.writeFileSync(path.join(userSkills, 'malformed', 'SKILL.md'), 'not frontmatter', 'utf8');
  fs.symlinkSync(enabledSkill, path.join(userSkills, 'enabled-alias'), 'dir');
  writeSkill(path.join(root, 'repo', '.agents', 'skills'), 'repo-agent', 'name: repo-agent');
  writeSkill(
    path.join(root, 'repo', '.codex', 'skills'),
    'repo-codex',
    'name: repo-codex\nenabled: true'
  );
  writeSkill(systemSkills, 'system', 'name: system\nenabled: true');
  writeSkill(adminSkills, 'admin', 'name: admin\nenabled: true');

  writeHooks(path.join(codexHome, 'hooks.json'), [
    { command: 'user-hook', enabled: true },
    { command: 'disabled-hook', enabled: false },
    'malformed-hook',
  ]);
  writeHooks(path.join(root, 'repo', '.codex', 'hooks.json'), [
    { command: 'repo-hook', enabled: true, sourcePath: '/hooks/repo' },
  ]);
  writeHooks(path.join(root, 'repo', '.agents', 'hooks.json'), [
    { command: 'repo-hook-duplicate', enabled: true, sourcePath: '/hooks/repo' },
  ]);
  writeHooks(path.join(root, 'system', 'hooks.json'), [
    { command: 'system-hook', enabled: true },
  ]);
  writeHooks(path.join(root, 'admin', 'hooks.json'), [
    { command: 'admin-hook', enabled: true },
  ]);

  const env = {
    CODEX_HOME: codexHome,
    CODEX_SYSTEM_SKILLS_DIR: systemSkills,
    CODEX_SYSTEM_HOOKS_FILE: path.join(root, 'system', 'hooks.json'),
    CODEX_ADMIN_SKILLS_DIR: adminSkills,
    CODEX_ADMIN_HOOKS_FILE: path.join(root, 'admin', 'hooks.json'),
  };
  const counts = await collectCodexAssetCounts(cwd, env);

  assert.deepEqual(counts, { skillsCount: 5, hooksCount: 4 });
  const runtimeHookOverrides = [
    'hooks.event=[{command="user-hook",enabled=true}]',
    `hooks.Stop=[{hooks=[{type="command",command='''/hooks/runtime-stop'''}]}]`,
  ];
  assert.deepEqual(
    await collectCodexAssetCounts(cwd, env, undefined, {
      runtimeHookOverrides,
    }),
    { skillsCount: 5, hooksCount: 5 },
    'runtime hooks should merge with static entries and deduplicate the same handler'
  );
  assert.deepEqual(
    await collectCodexAssetCounts(cwd, env, { hooks: false }),
    { skillsCount: 5, hooksCount: 0 }
  );
  assert.deepEqual(
    await collectCodexAssetCounts(cwd, env, { hooks: false }, {
      runtimeHookOverrides,
    }),
    { skillsCount: 5, hooksCount: 0 },
    'runtime overrides alone must not imply that the hook feature is enabled'
  );
  assert.deepEqual(
    await collectCodexAssetCounts(cwd, env, { hooks: false }, {
      runtimeHookOverrides,
      runtimeHooksEnabled: true,
    }),
    { skillsCount: 5, hooksCount: 5 },
    'an explicit runtime enable should reactivate static hooks and merge runtime entries'
  );
  assert.deepEqual(
    await collectCodexAssetCounts(cwd, env, undefined, {
      runtimeHookOverrides,
      runtimeHooksEnabled: false,
    }),
    { skillsCount: 5, hooksCount: 0 },
    'an explicit runtime disable should suppress both static and runtime hooks'
  );
  assert.deepEqual(
    await collectCodexAssetCounts(cwd, env, { hooks: false }, {
      runtimeHooksEnabled: true,
    }),
    { skillsCount: 5, hooksCount: 4 },
    'an explicit runtime enable should override a disabled static feature flag'
  );
  console.log(
    `test-codex-assets: PASS (skills=${counts.skillsCount}, static_hooks=${counts.hooksCount}, merged_hooks=5)`
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
