import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'codex-hud-slow-worker-')
);
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

  const { SlowProjectWorkerClient } = await import(
    '../../dist/collectors/slow-project-client.js'
  );
  const client = new SlowProjectWorkerClient();
  try {
    const snapshot = await client.collect(projectRoot, {
      forceAssetRefresh: true,
    });
    assert.equal(snapshot.config.model, 'gpt-fixture');
    assert.equal(snapshot.project.mcpCount, 1);
    assert.equal(snapshot.project.skillsCount, 2);
    assert.equal(snapshot.project.otherAgentSkillsCount, 1);
    assert.equal(snapshot.project.globalConfigActive, true);
    assert.equal(snapshot.configError, undefined);
    assert.ok(snapshot.collectedAt instanceof Date);

    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      'model = "unterminated\n',
      'utf8'
    );
    const malformed = await client.collect(projectRoot, {
      forceAssetRefresh: true,
    });
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
    const wrongType = await client.collect(projectRoot, {
      forceAssetRefresh: true,
    });
    assert.match(wrongType.configError ?? '', /model must be a string/);
    assert.equal(wrongType.config.model, 'gpt-fixture');
  } finally {
    await client.close();
  }

  // A crashed worker must not disable the collector for the rest of the HUD
  // lifetime: the next collect after the backoff respawns a fresh worker.
  fs.writeFileSync(
    path.join(codexHome, 'config.toml'),
    'model = "gpt-fixture"\n[mcp_servers.fixture]\ncommand = ["fixture"]\n',
    'utf8'
  );
  const respawnClient = new SlowProjectWorkerClient({
    respawnBackoffMinMs: 500,
    respawnBackoffMaxMs: 1000,
  });
  try {
    const beforeCrash = await respawnClient.collect(projectRoot, {
      forceAssetRefresh: true,
    });
    assert.equal(beforeCrash.config.model, 'gpt-fixture');

    // Simulate a crash by terminating the thread out from under the client
    // (fires the same 'exit' the client sees on a real crash).
    const dyingWorker = respawnClient.worker;
    assert.ok(dyingWorker, 'client must hold a live worker before the crash');
    await dyingWorker.terminate();
    for (let i = 0; i < 200 && respawnClient.worker !== null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      respawnClient.worker,
      null,
      'the crashed worker must be dropped'
    );

    await assert.rejects(
      respawnClient.collect(projectRoot, {}),
      /exited with code/,
      'collects inside the respawn backoff reject with the crash cause'
    );

    await new Promise((resolve) => setTimeout(resolve, 550));
    const afterRespawn = await respawnClient.collect(projectRoot, {
      forceAssetRefresh: true,
    });
    assert.equal(
      afterRespawn.config.model,
      'gpt-fixture',
      'a collect after the backoff respawns the worker and succeeds'
    );
  } finally {
    await respawnClient.close();
  }

  console.log('test-slow-project-worker: PASS');
} finally {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  fs.rmSync(root, { recursive: true, force: true });
}
