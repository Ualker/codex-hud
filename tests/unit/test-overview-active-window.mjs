import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);

const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'codex-hud-overview-window-')
);

/** Write a rollout whose mtime is `ageMinutes` in the past. */
function writeRollout(codexHome, id, ageMinutes) {
  const at = new Date(Date.now() - ageMinutes * 60_000);
  const dir = path.join(
    codexHome,
    'sessions',
    String(at.getFullYear()),
    String(at.getMonth() + 1).padStart(2, '0'),
    String(at.getDate()).padStart(2, '0')
  );
  fs.mkdirSync(dir, { recursive: true });

  const stamp = at.toISOString().slice(0, 19).replace(/:/g, '-');
  const file = path.join(dir, `rollout-${stamp}-${id}.jsonl`);
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      timestamp: at.toISOString(),
      type: 'session_meta',
      payload: {
        id,
        timestamp: at.toISOString(),
        cwd: '/tmp/overview-window',
        originator: 'codex-tui',
        cli_version: '0.147.0',
        source: 'cli',
      },
    })}\n`,
    'utf8'
  );
  fs.utimesSync(file, at, at);
  return file;
}

/** Ages, in minutes, of the rollouts each window should surface. */
function activeAges(codexHome, windowSeconds) {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const { findActiveRollouts } = await import(${JSON.stringify(
        path.join(repoRoot, 'dist', 'collectors', 'session-finder.js')
      )});
       const found = findActiveRollouts(${windowSeconds}, undefined, 1);
       process.stdout.write(JSON.stringify(found.map((f) => f.sessionId)));`,
    ],
    { env: { ...process.env, CODEX_HOME: codexHome }, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  return new Set(JSON.parse(result.stdout));
}

try {
  const codexHome = path.join(tempRoot, 'codex');
  fs.mkdirSync(codexHome, { recursive: true });

  const midTurn = '019f1111-a111-7111-8111-111111111111';
  const idleFive = '019f2222-b222-7222-8222-222222222222';
  const idleTwenty = '019f3333-c333-7333-8333-333333333333';
  const yesterday = '019f4444-d444-7444-8444-444444444444';

  writeRollout(codexHome, midTurn, 0.2);
  writeRollout(codexHome, idleFive, 5);
  writeRollout(codexHome, idleTwenty, 20);
  writeRollout(codexHome, yesterday, 20 * 60);

  // The old 60-second window only ever caught a session mid-turn. Measured
  // live with two Codex sessions open and idle, the dashboard rendered
  // "No active sessions" — one of the HUD's two hotkeys returned nothing.
  const oneMinute = activeAges(codexHome, 60);
  assert.ok(oneMinute.has(midTurn));
  assert.equal(
    oneMinute.has(idleFive),
    false,
    'the old window excluded a session idle for five minutes'
  );

  // The overview already ranks idle rows last and carries an age column; the
  // window is what those columns were built for.
  const thirtyMinutes = activeAges(codexHome, 30 * 60);
  assert.ok(thirtyMinutes.has(midTurn), 'a working session still leads');
  assert.ok(thirtyMinutes.has(idleFive), 'a recently-worked session appears');
  assert.ok(thirtyMinutes.has(idleTwenty), 'so does one idle for twenty minutes');
  assert.equal(
    thirtyMinutes.has(yesterday),
    false,
    'the window still bounds the dashboard to current work'
  );

  console.log('test-overview-active-window: PASS');
} finally {
  const resolvedRoot = fs.realpathSync(tempRoot);
  assert.equal(path.dirname(resolvedRoot), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolvedRoot).startsWith('codex-hud-overview-window-'));
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
}
