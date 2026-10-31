import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-diagnostic-safety-'));
let retained;
try {
  const rc = path.join(root, '.zshrc');
  fs.writeFileSync(rc, '# codex-hud alias\nalias codex=existing\n');
  const before = fs.readFileSync(rc, 'utf8');
  const marker = path.join(root, 'tmux-called');
  fs.writeFileSync(path.join(root, 'tmux'), `#!/bin/sh\necho called > '${marker}'\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: root, PATH: root };
  for (const name of ['test-install.sh', 'test-tmux-integration.sh']) {
    const result = spawnSync('/bin/bash', [path.join(repo, 'tests', name)], { env, encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /retired/);
  }
  assert.equal(fs.readFileSync(rc, 'utf8'), before, 'legacy tests leave shell configuration intact');
  assert.equal(fs.existsSync(marker), false, 'legacy tests never connect to tmux');

  // A harmless tmux substitute gets the benchmark to its missing-SQLite
  // failure path. No real tmux server or user database is involved.
  fs.writeFileSync(path.join(root, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const failed = spawnSync(process.execPath, [path.join(repo, 'scripts/benchmark-runtime.mjs'),
    '--instances', '1', '--seconds', '5', '--history-mib', '1'], { env, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(failed.status, 0);
  retained = failed.stderr.match(/diagnostics retained at (.+)/)?.[1];
  assert.ok(retained, failed.stderr);
  assert.equal(path.dirname(retained), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(retained).startsWith('hud-runtime-bench-'));
  assert.match(fs.readFileSync(path.join(retained, 'failure.txt'), 'utf8'), /sqlite3.*ENOENT/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(retained, 'partial-report.json'), 'utf8')).fixtureVersion, 2);
  console.log('test-review-diagnostic-safety: PASS (retired scripts, retained benchmark failure)');
} finally {
  if (retained && path.dirname(retained) === fs.realpathSync(os.tmpdir()) && path.basename(retained).startsWith('hud-runtime-bench-')) {
    fs.rmSync(retained, { recursive: true, force: true });
  }
  fs.rmSync(root, { recursive: true, force: true });
}
