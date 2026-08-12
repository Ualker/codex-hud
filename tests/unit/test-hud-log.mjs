import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { logHudError } from '../../dist/utils/hud-log.js';

const modulePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dist',
  'utils',
  'hud-log.js'
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-log-'));
const logFile = path.join(dir, 'hud.log');
const originalLogFile = process.env.CODEX_HUD_LOG_FILE;

/**
 * The default destination is resolved once per process, so each case needs a
 * fresh one. HOME is redirected so the probe never touches the real home.
 */
function logInChild(env) {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const { logHudError } = await import(${JSON.stringify(modulePath)});
       logHudError('scope', new Error('child-message'));`,
    ],
    { env: { ...process.env, ...env }, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
}

try {
  {
    // An uncaught exception used to vanish entirely when CODEX_HUD_LOG_FILE was
    // unset — which it is by default, because the wrapper never sets it. The
    // pane cannot show a stack trace, so the file is the only place it can go.
    const home = path.join(dir, 'home');
    fs.mkdirSync(home, { recursive: true });
    logInChild({ HOME: home, CODEX_HUD_LOG_FILE: undefined });

    const macDefault = path.join(home, 'Library', 'Logs', 'codex-hud', 'hud.log');
    const xdgDefault = path.join(home, '.local', 'state', 'codex-hud', 'hud.log');
    const written = [macDefault, xdgDefault].filter((file) =>
      fs.existsSync(file)
    );
    assert.equal(
      written.length,
      1,
      'exactly one per-user default receives the diagnostic'
    );
    assert.match(fs.readFileSync(written[0], 'utf8'), /\[scope\] Error: child-message/);
  }

  {
    // Opting back into silence stays possible.
    const home = path.join(dir, 'home-off');
    fs.mkdirSync(home, { recursive: true });
    logInChild({ HOME: home, CODEX_HUD_LOG_FILE: 'off' });
    assert.equal(
      fs.existsSync(path.join(home, 'Library')),
      false,
      'CODEX_HUD_LOG_FILE=off writes nothing at all'
    );
    assert.equal(fs.existsSync(path.join(home, '.local')), false);
  }

  process.env.CODEX_HUD_LOG_FILE = logFile;
  logHudError('scope', new Error('recorded'));
  logHudError('other', 'plain message');
  const content = fs.readFileSync(logFile, 'utf8');
  assert.match(content, /\[scope\] Error: recorded/);
  assert.match(content, /\[other\] plain message/);

  // Logging must never throw, even when the target is unwritable.
  process.env.CODEX_HUD_LOG_FILE = path.join(dir, 'missing', 'nested', 'x.log');
  assert.doesNotThrow(() => logHudError('scope', 'unwritable target'));

  // A file at the size limit restarts instead of growing without bound.
  const rotatingFile = path.join(dir, 'rotating.log');
  fs.writeFileSync(rotatingFile, 'x'.repeat(5 * 1024 * 1024));
  process.env.CODEX_HUD_LOG_FILE = rotatingFile;
  logHudError('scope', 'after rotation');
  const rotated = fs.readFileSync(rotatingFile, 'utf8');
  assert.ok(
    rotated.length < 1024,
    `an oversized log restarts from scratch (${rotated.length} bytes)`
  );
  assert.match(rotated, /previous contents truncated/);
  assert.match(rotated, /\[scope\] after rotation/);
} finally {
  if (originalLogFile === undefined) {
    delete process.env.CODEX_HUD_LOG_FILE;
  } else {
    process.env.CODEX_HUD_LOG_FILE = originalLogFile;
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('test-hud-log: PASS');
