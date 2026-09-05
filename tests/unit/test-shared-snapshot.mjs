import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Several HUDs open in one directory each ran the same account-quota scan
// and the same `git status`; whichever refreshes first now shares the answer
// through a per-user file that the others read while it is fresh.

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-shared-'));
const originalHome = process.env.HOME;
const originalXdg = process.env.XDG_STATE_HOME;
process.env.HOME = home;
process.env.XDG_STATE_HOME = path.join(home, 'state');

try {
  const { readSharedSnapshot, writeSharedSnapshot } = await import(
    '../../dist/utils/shared-snapshot.js'
  );
  const revive = (raw) =>
    typeof raw === 'object' && raw !== null && typeof raw.value === 'number' ? raw : null;

  const t0 = 1_800_000_000_000;
  assert.equal(readSharedSnapshot('probe', 5000, revive, t0), null, 'nothing shared yet');
  writeSharedSnapshot('probe', { value: 42 }, t0);
  assert.deepEqual(readSharedSnapshot('probe', 5000, revive, t0 + 1000), { value: 42 });
  assert.equal(
    readSharedSnapshot('probe', 5000, revive, t0 + 6000),
    null,
    'a stale file from a dead HUD is not served'
  );
  assert.equal(
    readSharedSnapshot('probe', 5000, () => null, t0 + 1000),
    null,
    'the reviver can reject a shape it does not trust'
  );
  writeSharedSnapshot('probe', { value: 'not a number' }, t0 + 2000);
  assert.equal(readSharedSnapshot('probe', 5000, revive, t0 + 2500), null);

  // The write is atomic: no temp file is left behind. The state directory
  // follows utils/state-dir.ts (Application Support on macOS, XDG elsewhere).
  const stateDir =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'codex-hud')
      : path.join(home, 'state', 'codex-hud');
  const dir = fs.readdirSync(stateDir);
  assert.ok(dir.includes('shared-probe.json'));
  assert.equal(dir.some((name) => name.endsWith('.tmp')), false);

  console.log('test-shared-snapshot: PASS');
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalXdg === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalXdg;
  fs.rmSync(home, { recursive: true, force: true });
}
