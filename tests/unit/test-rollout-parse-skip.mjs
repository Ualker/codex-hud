import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RolloutParser } from '../../dist/collectors/rollout.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-parse-skip-'));
const filePath = path.join(
  dir,
  'rollout-2026-08-05T12-00-00-0123abcd-0000-0000-0000-000000000000.jsonl'
);

function line(record) {
  return `${JSON.stringify(record)}\n`;
}

try {
  fs.writeFileSync(
    filePath,
    line({
      timestamp: '2026-08-05T12:00:00Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-1' },
    }),
    'utf8'
  );

  const parser = new RolloutParser(10);
  parser.setRolloutPath(filePath);
  const first = await parser.parse();
  assert.ok(first, 'initial parse returns a result');
  assert.equal(first.turnActivity?.phase, 'thinking');

  // The 2s fallback poll calls parse without any file change; the cached
  // result object must be served without re-reading or re-merging.
  const second = await parser.parse();
  assert.equal(
    second,
    first,
    'an unchanged file returns the cached result object'
  );

  // A partial (uncommitted) line grows the file past the committed offset,
  // so it takes the full path — and must not advance past the last newline.
  fs.appendFileSync(filePath, '{"timestamp":"2026-08-05T12:00:02Z"', 'utf8');
  const partial = await parser.parse();
  assert.equal(
    partial.turnActivity?.phase,
    'thinking',
    'a partial tail leaves the parsed state unchanged'
  );

  fs.appendFileSync(
    filePath,
    ',"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1"}}\n',
    'utf8'
  );
  const third = await parser.parse();
  assert.equal(
    third.turnActivity?.phase,
    'idle',
    'records appended after a skip are still picked up'
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('test-rollout-parse-skip: PASS');
