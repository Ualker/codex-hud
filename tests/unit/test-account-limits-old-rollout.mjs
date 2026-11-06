import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeSql } from '../helpers/sqlite.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-quota-old-'));
process.env.HOME = root;
process.env.CODEX_HOME = path.join(root, '.codex');
delete process.env.CODEX_SESSIONS_PATH;
delete process.env.TMUX;
const { findLatestAccountRateLimits } = await import('../../dist/collectors/account-limits.js');
const now = Date.now();
function rollout(id, createdDaysAgo, used, observedAgo) {
  const created = new Date(now - createdDaysAgo * 86400000);
  const dir = path.join(process.env.CODEX_HOME, 'sessions', String(created.getFullYear()),
    String(created.getMonth() + 1).padStart(2, '0'), String(created.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${created.toISOString().slice(0, 19).replaceAll(':', '-')}-${id}.jsonl`);
  const timestamp = new Date(now - observedAgo).toISOString();
  const records = [{ timestamp, type: 'session_meta', payload: { id, cwd: root } },
    { timestamp, type: 'event_msg', payload: { type: 'token_count', rate_limits: {
      limit_id: 'codex', primary: { used_percent: used, window_minutes: 300, resets_at: Math.floor(now / 1000) + 3600 },
    } } }];
  fs.writeFileSync(file, records.map(JSON.stringify).join('\n') + '\n');
  fs.utimesSync(file, (now - observedAgo) / 1000, (now - observedAgo) / 1000);
  return file;
}
try {
  const old = rollout('10000000-1111-7000-8000-111111111111', 30, 95, 0);
  rollout('10000000-2222-7000-8000-222222222222', 0, 10, 120000);
  assert.equal((await findLatestAccountRateLimits([old])).limits.primary.used_percent, 95, 'bound paths work without a state DB');
  const db = path.join(process.env.CODEX_HOME, 'state_5.sqlite');
  executeSql(db, `CREATE TABLE threads(id TEXT, rollout_path TEXT, updated_at INTEGER, archived INTEGER);
    INSERT INTO threads VALUES ('old', '${old.replaceAll("'", "''")}', ${Math.floor(now / 1000)}, 0);`);
  assert.equal((await findLatestAccountRateLimits()).limits.primary.used_percent, 95, 'recent index activity outranks creation dates');
  executeSql(db, 'UPDATE threads SET archived = 1;');
  assert.equal((await findLatestAccountRateLimits()).limits.primary.used_percent, 10, 'archive rows do not enter active discovery');
  console.log('test-account-limits-old-rollout: PASS');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
