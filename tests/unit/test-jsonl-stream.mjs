import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanCompleteJsonl } from '../../dist/utils/jsonl-tail.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-jsonl-stream-'));
const file = path.join(root, 'records.jsonl');
async function scan(offset = 0, limit) {
  const records = [];
  const nextOffset = await scanCompleteJsonl(file, offset, (record) => { records.push(record); }, limit);
  return { records, nextOffset };
}
try {
  // A multibyte codepoint straddles the 64 KiB read boundary; the line itself
  // spans multiple chunks and ends with CRLF. Cursors must count bytes.
  const value = 'x'.repeat(65_529) + '中文🙂'.repeat(15_000);
  const line = JSON.stringify({ v: value }) + '\r\n';
  fs.writeFileSync(file, '\n' + line + '{"pending":"中');
  const first = await scan();
  assert.deepEqual(first.records, [{ v: value }]);
  assert.equal(first.nextOffset, Buffer.byteLength('\n' + line));
  assert.deepEqual((await scan(first.nextOffset)).records, []);
  fs.appendFileSync(file, '文"}\n');
  const appended = await scan(first.nextOffset);
  assert.deepEqual(appended.records, [{ pending: '中文' }]);
  assert.equal(appended.nextOffset, fs.statSync(file).size);

  // The scan stops at its original EOF even if the writer appends while an
  // async consumer is running. The next call receives the appended record.
  fs.writeFileSync(file, '{"first":1}\n');
  const before = fs.statSync(file).size;
  const seen = [];
  const offset = await scanCompleteJsonl(file, 0, async (record) => {
    seen.push(record);
    fs.appendFileSync(file, '{"later":2}\n');
    await Promise.resolve();
  });
  assert.equal(offset, before);
  assert.deepEqual(seen, [{ first: 1 }]);
  assert.deepEqual((await scan(offset)).records, [{ later: 2 }]);

  fs.writeFileSync(file, '{"a":1}\n{"b":2}\n');
  assert.equal((await scan(0, 7)).records.length, 2, 'limit is per line, not per file');
  await assert.rejects(scan(0, 6), { code: 'JSONL_RECORD_TOO_LARGE' });
  fs.writeFileSync(file, '12345678');
  await assert.rejects(scan(0, 7), { code: 'JSONL_RECORD_TOO_LARGE' }, 'partial lines are bounded too');

  fs.writeFileSync(file, '{"ok":1}\n{private-malformed-text}\n');
  await assert.rejects(scan(), (error) => {
    assert.equal(error.code, 'JSONL_INVALID');
    assert.match(error.message, /byte 9/);
    assert.doesNotMatch(error.message, /private-malformed-text/);
    return true;
  });
  fs.writeFileSync(file, '');
  await assert.rejects(scan(100), { code: 'JSONL_TRUNCATED' });
  for (const offset of [-1, 0.5, NaN, Infinity]) await assert.rejects(scan(offset), RangeError);
  for (const limit of [-1, 0, Infinity]) await assert.rejects(scan(0, limit), RangeError);
  await assert.rejects(scanCompleteJsonl(file, 0, () => { throw new Error('consumer'); }, 0), RangeError);
  fs.writeFileSync(file, '{}\n');
  await assert.rejects(scanCompleteJsonl(file, 0, () => { throw new Error('consumer'); }), /consumer/);
  assert.equal((await scan()).nextOffset, 3, 'a failed consumer does not poison a later scan');
  console.log('test-jsonl-stream: PASS');
} finally {
  fs.rmSync(root, { recursive: true });
}
