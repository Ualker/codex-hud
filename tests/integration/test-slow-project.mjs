import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The slow collectors run in-process on the async filesystem API now (the
// worker thread cost a second V8 isolate per HUD, measured 14.5MB). The
// contract the worker kept — a malformed config retains the last good one
// and never suppresses the independent project counts — is what this proves.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-slow-project-'));
const codexHome = path.join(root, 'home', '.codex');
const projectRoot = path.join(root, 'repo');
const originalCodexHome = process.env.CODEX_HOME;

function writeSkill(skillRoot, name) {
  const directory = path.join(skillRoot, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\nenabled: true\n---\n# ${name}\n`,
    'utf8'
  );
}

try {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, 'config.toml'),
    'model = "gpt-fixture"\n[mcp_servers.fixture]\ncommand = ["fixture"]\n',
    'utf8'
  );
  writeSkill(path.join(codexHome, 'skills'), 'global-codex');
  writeSkill(path.join(projectRoot, '.codex', 'skills'), 'project-codex');
  writeSkill(path.join(projectRoot, '.agents', 'skills'), 'other-agent');
  process.env.CODEX_HOME = codexHome;

  const { collectSlowProjectSnapshot } = await import(
    '../../dist/collectors/slow-project.js'
  );

  const snapshot = await collectSlowProjectSnapshot(projectRoot, {
    forceAssetRefresh: true,
  });
  assert.equal(snapshot.config.model, 'gpt-fixture');
  assert.equal(snapshot.project.mcpCount, 1);
  assert.equal(snapshot.project.skillsCount, 2);
  assert.equal(snapshot.project.otherAgentSkillsCount, 1);
  assert.equal(snapshot.project.globalConfigActive, true);
  assert.equal(snapshot.configError, undefined);
  assert.ok(snapshot.collectedAt instanceof Date);

  // The event loop stays free while the walk runs: a timer fires between
  // the awaits instead of after the whole collection.
  {
    let ticked = false;
    const timer = setTimeout(() => {
      ticked = true;
    }, 0);
    await collectSlowProjectSnapshot(projectRoot, { forceAssetRefresh: true });
    clearTimeout(timer);
    assert.equal(ticked, true, 'the collection yields to the event loop');
  }

  fs.writeFileSync(
    path.join(codexHome, 'config.toml'),
    'model = "unterminated\n',
    'utf8'
  );
  const malformed = await collectSlowProjectSnapshot(
    projectRoot,
    { forceAssetRefresh: true },
    snapshot.config
  );
  assert.match(malformed.configError ?? '', /Unexpected|unterminated|line/i);
  assert.equal(
    malformed.config.model,
    'gpt-fixture',
    'a malformed config must retain the last successful config snapshot'
  );
  assert.equal(
    malformed.project.skillsCount,
    2,
    'config failure must not suppress independent project asset collection'
  );

  fs.writeFileSync(
    path.join(codexHome, 'config.toml'),
    'model = 123\n',
    'utf8'
  );
  const wrongType = await collectSlowProjectSnapshot(
    projectRoot,
    { forceAssetRefresh: true },
    snapshot.config
  );
  assert.match(wrongType.configError ?? '', /model must be a string/);
  assert.equal(wrongType.config.model, 'gpt-fixture');

  fs.rmSync(path.join(codexHome, 'config.toml'));
  const missing = await collectSlowProjectSnapshot(projectRoot, {
    forceAssetRefresh: true,
  });
  assert.deepEqual(missing.config, {}, 'no config file is an empty config, not an error');
  assert.equal(missing.configError, undefined);
  assert.equal(missing.project.globalConfigActive, false);

  console.log('test-slow-project: PASS');
} finally {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  fs.rmSync(root, { recursive: true, force: true });
}
