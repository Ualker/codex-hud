import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionFinder, findRolloutByThreadId, findActiveRollouts } from '../../dist/collectors/session-finder.js';
import { calculateContextUsage } from '../../dist/context-usage.js';
import { executeSql } from '../helpers/sqlite.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-rollout-replacement-'));
const saved = Object.fromEntries(['CODEX_HOME', 'CODEX_SESSIONS_PATH', 'CODEX_HUD_MAIN_PANE'].map(k => [k, process.env[k]]));
const id = '01a0e6ac-2c67-7550-aa6a-112ce7bfc2fe';
const other = '01a0ebe5-3ebf-7d71-a33a-c18494544858';
const now = new Date();
const day = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')];
const dir = path.join(root, 'sessions', ...day.map(String));
fs.mkdirSync(dir, { recursive: true });
const q = x => String(x).replaceAll("'", "''");
function write(hour, suffix = '', metadataId = id) {
  const p = path.join(dir, `rollout-${day.join('-')}T${hour}-00-00-${id}${suffix}.jsonl`);
  fs.writeFileSync(p, JSON.stringify({ type: 'session_meta', payload: { id: metadataId, cwd: root } }) + '\n');
  return fs.realpathSync(p);
}

try {
  process.env.CODEX_HOME = root;
  delete process.env.CODEX_SESSIONS_PATH;
  process.env.CODEX_HUD_MAIN_PANE = '%test';
  const old = write('01');
  const current = write('02', `_${other}`);
  const decoy = write('03', '_aaaa', other);
  assert.equal(findRolloutByThreadId(id)?.path, current, 'a suffixed continuation supersedes the original file');
  assert.ok(!findActiveRollouts(60, root).some(r => r.path === decoy), 'metadata must validate the filename identity');
  assert.equal(findRolloutByThreadId(other), null, 'the suffix is not the session id');

  const db = path.join(root, 'state_5.sqlite');
  executeSql(db, `CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, thread_source TEXT, archived INTEGER);
    CREATE TABLE thread_spawn_edges (child_thread_id TEXT);
    INSERT INTO threads VALUES ('${id}', '${q(old)}', 'user', 0);`);
  const changes = [];
  const finder = new SessionFinder(root, s => changes.push(s?.path ?? null));
  finder.resolvePaneThreadBinding = async () => {
    await finder.annotateCandidates([{ threadId: id, lastTs: Date.now() }]);
    return { threadId: id, keepCurrent: true };
  };
  assert.equal((await finder.check(true))?.path, old, 'the database path wins over a newer filename');
  executeSql(db, `UPDATE threads SET rollout_path='${q(current)}' WHERE id='${id}';`);
  // No watcher event: polling must refresh positive facts too.
  finder.threadFactsCache.get(id).fetchedAt = 0;
  assert.equal((await finder.check(true))?.path, current, 'same id must rebind when its authoritative path moves');
  assert.deepEqual(changes, [old, current]);

  const next = write('04', '_bbbb');
  executeSql(db, `UPDATE threads SET rollout_path='${q(next)}' WHERE id='${id}';`);
  await finder.noteRolloutAppeared(next);
  assert.equal(finder.getCurrentSession()?.path, next, 'same-thread watcher bypasses the facts cache');

  executeSql(db, `UPDATE threads SET rollout_path='${q(decoy)}' WHERE id='${id}';`);
  finder.threadFactsCache.get(id).fetchedAt = 0;
  assert.equal(await finder.check(true), null, 'an invalid authoritative file must not silently resurrect old data');

  finder.resolvePaneThreadBinding = async () => ({ threadId: id, keepCurrent: true });
  executeSql(db, `UPDATE threads SET rollout_path='${q(current)}' WHERE id='${id}';`);
  finder.threadFactsCache.clear();
  await finder.annotateCandidates([{ threadId: id, lastTs: Date.now() }]);
  assert.equal((await finder.check(true))?.path, current);
  finder.resolvePaneThreadBinding = async () => ({ threadId: null, keepCurrent: false, daemonClient: true });
  assert.equal(await finder.check(true), null, 'ambiguous daemon reconnect must clear a previously bound rollout');

  assert.equal(100 - calculateContextUsage(205606, 258400).percent, 21);
  assert.equal(100 - calculateContextUsage(68871, 258400).percent, 77);
  console.log('test-session-finder-rollout-replacement: PASS');
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
}
