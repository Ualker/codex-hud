import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSqliteStatement, getSqliteDiagnostics } from '../../dist/utils/sqlite-probe.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-sqlite-probe-'));
process.env.CODEX_HUD_LOG_FILE = path.join(root, 'hud.log');
try {
  let time = 0;
  const calls = [];
  const db = { prepare(sql) {
    calls.push(sql);
    return { all() {
      if (sql.startsWith('EXPLAIN')) return [{ detail: 'SCAN logs' }];
      time += 60;
      if (sql === 'SELECT broken') throw Object.assign(new Error('synthetic read failure'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
      return [{ id: 1 }];
    } };
  } };
  assert.deepEqual(runSqliteStatement(db, "SELECT 'SYNTHETIC_PRIVATE_LITERAL'", () => time), [{ id: 1 }]);
  assert.throws(() => runSqliteStatement(db, 'SELECT broken', () => time), /synthetic read failure/);
  const stats = getSqliteDiagnostics();
  assert.equal(stats.statements, 2);
  assert.equal(stats.failures, 1);
  assert.equal(stats.lastErrorCode, 'ERR_SQLITE_ERROR:5');
  assert.equal(stats.overBudget, 2);
  assert.equal(stats.maxMs, 60);
  const log = fs.readFileSync(process.env.CODEX_HUD_LOG_FILE, 'utf8');
  assert.match(log, /SCAN logs/);
  assert.doesNotMatch(log, /SYNTHETIC_PRIVATE_LITERAL|SELECT broken/);
  assert.equal(calls.filter(sql => sql.startsWith('EXPLAIN')).length, 2);
  console.log('test-sqlite-probe: PASS');
} finally {
  delete process.env.CODEX_HUD_LOG_FILE;
  fs.rmSync(root, { recursive: true, force: true });
}
