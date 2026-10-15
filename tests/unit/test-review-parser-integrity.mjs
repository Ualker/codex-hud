import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RolloutParser } from '../../dist/collectors/rollout.js';
import { canonicalSessionMeta, taskStarted, taskComplete } from '../helpers/agent-rollout-fixture.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-parser-integrity-'));
const encode = records => records.map(JSON.stringify).join('\n') + '\n';
const response = payload => ({ timestamp: '2026-10-15T00:00:01Z', type: 'response_item', payload });
const parserFor = (name, records) => {
  const file = path.join(root, name);
  fs.writeFileSync(file, encode(records));
  const parser = new RolloutParser();
  parser.setRolloutPath(file);
  return { file, parser };
};

try {
  await test('bare, prefixed and clipped secret assignments never enter display summaries', async () => {
    for (const key of ['TOKEN', 'SECRET', 'PASSWORD', 'API_KEY', 'ACCESS_TOKEN', 'OPENAI_API_KEY', 'cookie']) {
      for (const value of ['SYNTHETIC_CREDENTIAL', '"SYNTHETIC_CREDENTIAL with spaces"', "'SYNTHETIC_CREDENTIAL\nsecond line'", '"SYNTHETIC_CREDENTIAL' + 'x'.repeat(5000)]) {
        const { parser } = parserFor('secrets.jsonl', [canonicalSessionMeta(), response({
          type: 'function_call', name: 'exec_command', call_id: 'call',
          arguments: JSON.stringify({ cmd: `${key}=${value} curl https://example.invalid` }),
        })]);
        const result = await parser.parse();
        const call = result.toolActivity.recentCalls[0];
        assert.doesNotMatch(JSON.stringify(call), /SYNTHETIC_CREDENTIAL/, `${key} must be masked`);
        assert.match(call.summary, /\*\*\*/);
      }
    }
  });

  await test('malformed nested payloads do not block a later completion', async () => {
    const bad = [
      { type: 'message', role: 'user', content: {} },
      { type: 'message', role: 'user', content: [null] },
      { type: 'function_call', name: 42, call_id: 'bad', arguments: '{}' },
      { type: 'function_call_output', call_id: 'good', output: [null] },
      { type: 'function_call_output', call_id: 'good', output: { content_items: [null] } },
    ];
    const { file, parser } = parserFor('malformed.jsonl', [canonicalSessionMeta(), taskStarted()]);
    await parser.parse();
    fs.appendFileSync(file, encode([
      response({ type: 'function_call', name: 'exec_command', call_id: 'good', arguments: '{}' }),
      ...bad.map(response), taskComplete(),
    ]));
    const result = await parser.parse();
    assert.equal(result.turnActivity.phase, 'idle');
    assert.equal(result.protocolHealth.malformedLines, bad.length);
    assert.equal(result.runtimeStateComplete, false);
    assert.equal(result.toolActivity.runningCalls.length, 0, 'a completed turn cannot retain a spinner from a malformed tool output');
    assert.equal(result.toolActivity.recentCalls[0].result.kind, 'unknown', 'missing output must not invent a successful exit code');
    assert.equal((await parser.parse()).protocolHealth.malformedLines, bad.length);
    assert.equal(parser.getDiagnostics().offset, fs.statSync(file).size);
  });

  await test('same-size replacement and rewrite reset accumulated state', async () => {
    const a = encode([canonicalSessionMeta({ id: 'session-a' }), taskStarted()]);
    const b = encode([canonicalSessionMeta({ id: 'session-b' }), taskStarted()]);
    assert.equal(a.length, b.length);
    const { file, parser } = parserFor('replacement.jsonl', []);
    fs.writeFileSync(file, a);
    assert.equal((await parser.parse()).session.id, 'session-a');
    fs.writeFileSync(`${file}.new`, b);
    fs.renameSync(`${file}.new`, file);
    assert.equal((await parser.parse()).session.id, 'session-b');
    fs.writeFileSync(file, a);
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(file, future, future);
    assert.equal((await parser.parse()).session.id, 'session-a');
  });

  await test('an incomplete tail waits for growth without repeatedly parsing it', async () => {
    const { file, parser } = parserFor('partial.jsonl', [canonicalSessionMeta(), taskStarted()]);
    await parser.parse();
    const completed = JSON.stringify(taskComplete());
    fs.appendFileSync(file, completed.slice(0, -1));
    const partial = await parser.parse();
    assert.ok(partial.pendingBytes > 0);
    assert.strictEqual(await parser.parse(), partial);
    fs.appendFileSync(file, '}\n');
    assert.equal((await parser.parse()).turnActivity.phase, 'idle');
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
