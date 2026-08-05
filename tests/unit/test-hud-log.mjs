import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { logHudError } from '../../dist/utils/hud-log.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-log-'));
const logFile = path.join(dir, 'hud.log');
const originalLogFile = process.env.CODEX_HUD_LOG_FILE;

try {
  delete process.env.CODEX_HUD_LOG_FILE;
  logHudError('scope', new Error('dropped'));
  assert.equal(
    fs.existsSync(logFile),
    false,
    'without CODEX_HUD_LOG_FILE nothing is written anywhere'
  );

  process.env.CODEX_HUD_LOG_FILE = logFile;
  logHudError('scope', new Error('recorded'));
  logHudError('other', 'plain message');
  const content = fs.readFileSync(logFile, 'utf8');
  assert.match(content, /\[scope\] Error: recorded/);
  assert.match(content, /\[other\] plain message/);

  // Logging must never throw, even when the target is unwritable.
  process.env.CODEX_HUD_LOG_FILE = path.join(dir, 'missing', 'nested', 'x.log');
  assert.doesNotThrow(() => logHudError('scope', 'unwritable target'));
} finally {
  if (originalLogFile === undefined) {
    delete process.env.CODEX_HUD_LOG_FILE;
  } else {
    process.env.CODEX_HUD_LOG_FILE = originalLogFile;
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('test-hud-log: PASS');
