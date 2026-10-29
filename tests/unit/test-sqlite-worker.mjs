import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeSql } from '../helpers/sqlite.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-sqlite-worker-'));
process.env.HOME = root;
process.env.XDG_STATE_HOME = path.join(root, 'state');
process.env.CODEX_HUD_LOG_FILE = path.join(root, 'hud.log');
const { querySqlite } = await import('../../dist/collectors/sqlite.js');
const { getSqliteDiagnostics } = await import('../../dist/utils/sqlite-probe.js');
const file = path.join(root, 'test.sqlite');
try {
  executeSql(file, 'CREATE TABLE facts (value TEXT); INSERT INTO facts VALUES ("first");'.replaceAll('"', "'"));
  assert.equal(await querySqlite(file, ['SELECT value FROM facts']), 'first');
  const before = getSqliteDiagnostics().statements;
  assert.equal(await querySqlite(file, ['SELECT value FROM facts']), 'first');
  assert.equal(getSqliteDiagnostics().statements, before, 'short-lived unchanged result is shared');
  executeSql(file, "UPDATE facts SET value='updated';");
  assert.equal(await querySqlite(file, ['SELECT value FROM facts']), 'updated', 'database writes invalidate cached results');
  let beats = 0;
  const timer = setInterval(() => beats++, 5);
  const statementsBefore = getSqliteDiagnostics().statements;
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () => querySqlite(file,
      ['WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000) SELECT sum(x) FROM n'])));
    assert.deepEqual(results, Array(4).fill('500000500000'));
  } finally { clearInterval(timer); }
  if (statementsBefore > 0) assert.equal(getSqliteDiagnostics().statements, statementsBefore + 1, 'simultaneous identical reads share one query');
  assert.ok(beats >= 3, `UI heartbeat must continue during SQL; got ${beats}`);
  const next = path.join(root, 'next.sqlite');
  executeSql(next, "CREATE TABLE facts (value TEXT); INSERT INTO facts VALUES ('replacement');");
  fs.renameSync(next, file);
  assert.equal(await querySqlite(file, ['SELECT value FROM facts']), 'replacement');
  assert.equal(await querySqlite(file, ['SELECT * FROM missing_table']), null);
  assert.equal(await querySqlite(file, ['SELECT value FROM facts']), 'replacement', 'failure does not poison later queries');
  const wal = path.join(root, 'wal.sqlite');
  executeSql(wal, "PRAGMA journal_mode=WAL; CREATE TABLE facts(value); INSERT INTO facts VALUES ('before WAL write');");
  assert.equal(await querySqlite(wal, ['SELECT value FROM facts']), 'before WAL write');
  executeSql(wal, "UPDATE facts SET value='after WAL write';");
  assert.equal(await querySqlite(wal, ['SELECT value FROM facts']), 'after WAL write', 'WAL changes invalidate cached reads');
  console.log(`test-sqlite-worker: PASS (UI heartbeats=${beats})`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
