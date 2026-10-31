import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/sqlite-backend.mjs', import.meta.url));
const probe = env => spawnSync(process.execPath, [script, '--json'], { env, encoding: 'utf8', timeout: 8000 });
const normal = probe(process.env);
assert.equal(normal.status, 0, normal.stderr);
assert.ok(['native', 'cli'].includes(JSON.parse(normal.stdout).backend));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-sqlite-backend-'));
try {
  const env = { ...process.env, PATH: dir };
  if (process.allowedNodeEnvironmentFlags.has('--no-experimental-sqlite')) {
    env.NODE_OPTIONS = '--no-experimental-sqlite';
  }
  const missing = probe(env);
  assert.equal(missing.status, 1, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).backend, 'unavailable');
  fs.writeFileSync(path.join(dir, 'sqlite3'), '#!/bin/sh\nprintf "1\\n"\n', { mode: 0o755 });
  const fallback = probe(env);
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.equal(JSON.parse(fallback.stdout).backend, 'cli');
  console.log('test-sqlite-backend: PASS (native capability, missing backend, CLI fallback)');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
