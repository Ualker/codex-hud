import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RolloutParser } from '../../dist/collectors/rollout.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-compact-'));

function line(record) {
  return `${JSON.stringify(record)}\n`;
}

function topLevelCompacted(iso) {
  return line({ timestamp: iso, type: 'compacted', payload: {} });
}

function eventCompacted(iso) {
  return line({
    timestamp: iso,
    type: 'event_msg',
    payload: { type: 'context_compacted' },
  });
}

async function parseFile(content) {
  const filePath = path.join(
    dir,
    `rollout-2026-08-04T12-00-00-${Math.random().toString(16).slice(2)}.jsonl`
  );
  fs.writeFileSync(filePath, content, 'utf8');
  const parser = new RolloutParser(10);
  parser.setRolloutPath(filePath);
  const result = await parser.parse();
  return { filePath, parser, result };
}

try {
  // Codex writes each compaction BOTH as a top-level `compacted` record and a
  // `context_compacted` event (verified 1:1 across 38 real rollouts). The
  // displayed count must not double.
  const paired = await parseFile(
    topLevelCompacted('2026-08-04T12:00:01Z') +
      eventCompacted('2026-08-04T12:00:01Z')
  );
  assert.equal(
    paired.result.compactCount,
    1,
    'a paired compaction must count once, not twice'
  );

  // Versions that write only one of the record kinds still count correctly.
  const topOnly = await parseFile(topLevelCompacted('2026-08-04T12:00:01Z'));
  assert.equal(topOnly.result.compactCount, 1, 'top-level-only counts once');

  const eventOnly = await parseFile(eventCompacted('2026-08-04T12:00:01Z'));
  assert.equal(eventOnly.result.compactCount, 1, 'event-only counts once');

  // Incremental parsing across batches keeps the pairing collapsed.
  const incremental = await parseFile(
    topLevelCompacted('2026-08-04T12:00:01Z') +
      eventCompacted('2026-08-04T12:00:01Z')
  );
  fs.appendFileSync(
    incremental.filePath,
    topLevelCompacted('2026-08-04T12:10:00Z') +
      eventCompacted('2026-08-04T12:10:00Z'),
    'utf8'
  );
  const merged = await incremental.parser.parse();
  assert.equal(
    merged.compactCount,
    2,
    'two paired compactions across incremental batches must count twice'
  );
  assert.equal(merged.compactTopLevelCount, 2);
  assert.equal(merged.compactEventCount, 2);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('test-rollout-compact-count: PASS');
