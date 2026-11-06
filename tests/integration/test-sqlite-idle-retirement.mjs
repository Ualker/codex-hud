import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { executeSql } from '../helpers/sqlite.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-sqlite-idle-'));
process.env.HOME = root;
process.env.XDG_STATE_HOME = path.join(root, 'state');
process.env.CODEX_HUD_LOG_FILE = 'off';
const { querySqlite, getSqliteWorkerResources } = await import('../../dist/collectors/sqlite.js');
const file = path.join(root, 'fixture.sqlite');
try {
  executeSql(file, "CREATE TABLE facts(value TEXT); INSERT INTO facts VALUES ('before');");
  assert.equal(await querySqlite(file, ['SELECT value FROM facts']), 'before');
  if (getSqliteWorkerResources().active) {
    await delay(31_000);
    assert.equal(getSqliteWorkerResources().active, false, 'a real idle interval releases the worker without a manual release call');
  }
  executeSql(file, "UPDATE facts SET value='after';");
  assert.equal(await querySqlite(file, ['SELECT value FROM facts']), 'after', 'the next read resumes with current data');
  console.log('test-sqlite-idle-retirement: PASS');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
