import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RolloutParser } from '../../dist/collectors/rollout.js';
import { peekRolloutMetadata } from '../../dist/collectors/session-finder.js';
import { buildContextUsage } from '../../dist/context-usage.js';
import { normalizeRolloutRecord } from '../../dist/protocol/rollout-record.js';
import { freezeFileRevision } from '../helpers/frozen-file-revision.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-cross-reader-'));
const file = path.join(root, 'rollout.jsonl');
const record = (type, payload) => ({ timestamp: new Date().toISOString(), type, payload });
const encode = records => records.map(JSON.stringify).join('\n') + '\n';
const meta = id => record('session_meta', { id, cwd: root });
const start = id => record('event_msg', { type: 'task_started', turn_id: id });
const done = id => record('event_msg', { type: 'task_complete', turn_id: id });
const usage = value => record('event_msg', { type: 'token_count', info: {
  model_context_window: 128000, last_token_usage: { total_tokens: value },
} });
const parserFor = () => { const p = new RolloutParser(); p.setRolloutPath(file); return p; };
try {
  for (const change of ['longer', 'shorter', 'same-size', 'same-stat']) {
    const before = encode([meta('session-a'), start('turn-a')]);
    let after = encode([meta('session-b'), start('turn-b'), done('turn-b')]);
    const initial = change === 'longer' ? before : before + ' '.repeat(after.length + 100);
    if (change === 'same-size' || change === 'same-stat') after += ' '.repeat(initial.length - after.length);
    fs.writeFileSync(file, initial);
    const warm = parserFor();
    await warm.parse();
    assert.equal(peekRolloutMetadata(file).sessionId, 'session-a');
    const inode = fs.statSync(file).ino;
    const restore = change === 'same-stat' ? freezeFileRevision(file) : () => {};
    try {
      fs.writeFileSync(file, after);
      assert.equal(fs.statSync(file).ino, inode);
      const warmResult = await warm.parse(), coldResult = await parserFor().parse();
      assert.equal(warmResult.session.id, coldResult.session.id, change);
      assert.equal(warmResult.turnActivity.phase, coldResult.turnActivity.phase, change);
      assert.equal(peekRolloutMetadata(file).sessionId, 'session-b', `metadata cache: ${change}`);
    } finally { restore(); }
  }
  fs.writeFileSync(file, encode([meta('same-session'), start('a'), usage(20000)]));
  const parser = parserFor();
  await parser.parse();
  for (const invalid of ['not-a-number', -1, {}, []]) fs.appendFileSync(file, encode([usage(invalid)]));
  const invalid = await parser.parse();
  assert.equal(invalid.protocolHealth.malformedLines, 4);
  assert.equal(invalid.tokenUsage.last_token_usage.total_tokens, 20000, 'keep last valid usage');
  assert.ok(Number.isFinite(buildContextUsage(invalid.tokenUsage).percent));
  for (const bad of [NaN, Infinity, -Infinity]) assert.equal(normalizeRolloutRecord(usage(bad)), null);
  assert.equal(normalizeRolloutRecord(record('event_msg', { type: 'token_count',
    rate_limits: { primary: { used_percent: 'bad' } } })), null);
  fs.appendFileSync(file, encode([usage(30000), done('a')]));
  const recovered = await parser.parse();
  assert.equal(recovered.tokenUsage.last_token_usage.total_tokens, 30000);
  assert.equal(recovered.turnActivity.phase, 'idle', 'malformed usage cannot block completion');
  console.log('test-rollout-cross-reader-integrity: PASS');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
