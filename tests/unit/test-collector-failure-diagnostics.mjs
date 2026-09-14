import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordCollectorFailure } from '../../dist/utils/collector-health.js';
import { JsonlReadError } from '../../dist/utils/jsonl-tail.js';
import { renderHealthLine } from '../../dist/render/lines/activity-line.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-collector-errors-'));
const original = process.env.CODEX_HUD_LOG_FILE;
const log = path.join(root, 'hud.log');
process.env.CODEX_HUD_LOG_FILE = log;
const strip = (value) => value.replace(/\x1b\[[0-9;]*m/g, '');
try {
  const error = new JsonlReadError('JSONL_INVALID', 'Invalid log at byte 42: /private/session.jsonl');
  const lastSuccessAt = new Date(1000);
  const fresh = { status: 'fresh', lastAttemptAt: new Date(2000), lastSuccessAt };
  const first = recordCollectorFailure('agents', error, fresh);
  for (let i = 0; i < 5; i++) recordCollectorFailure('agents', error, first);
  assert.equal(fs.readFileSync(log, 'utf8').match(/\[collector:agents\]/g).length, 1,
    'unchanged failures are logged only once');
  assert.equal(first.lastSuccessAt, lastSuccessAt);
  assert.equal(first.errorKind, 'invalid-log');
  const rendered = strip(renderHealthLine({ collectorHealth: { agents: first } }, 140));
  assert.match(rendered, /agent tracking unavailable \(invalid log\)/);
  assert.doesNotMatch(rendered, /private|byte 42|session.jsonl/);
  assert.match(fs.readFileSync(log, 'utf8'), /byte 42.*\/private\/session.jsonl/);

  recordCollectorFailure('agents', new Error('different failure'), first);
  recordCollectorFailure('agents', error, fresh);
  assert.equal(fs.readFileSync(log, 'utf8').match(/\[collector:agents\]/g).length, 3,
    'a changed cause or a failure after recovery is logged again');
  for (const [code, hint] of [
    ['ENOENT', 'file missing'], ['EACCES', 'permission denied'],
    ['JSONL_RECORD_TOO_LARGE', 'log record too large'], ['JSONL_TRUNCATED', 'log changed'],
  ]) {
    const health = recordCollectorFailure('agents', Object.assign(new Error('private value'), { code }));
    const row = strip(renderHealthLine({ collectorHealth: { agents: health } }, 140));
    assert.ok(row.includes(hint));
    assert.doesNotMatch(row, /private value/);
  }
  const unknown = recordCollectorFailure('agents', new Error('private unknown failure'));
  assert.match(strip(renderHealthLine({ collectorHealth: { agents: unknown } }, 140)), /see --doctor/);
  process.env.CODEX_HUD_LOG_FILE = 'off';
  const before = fs.statSync(log).size;
  recordCollectorFailure('agents', new Error('disabled logging'));
  assert.equal(fs.statSync(log).size, before);
  console.log('test-collector-failure-diagnostics: PASS');
} finally {
  if (original === undefined) delete process.env.CODEX_HUD_LOG_FILE;
  else process.env.CODEX_HUD_LOG_FILE = original;
  fs.rmSync(root, { recursive: true });
}
