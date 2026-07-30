import assert from 'node:assert/strict';

import { AsyncSnapshotCache } from '../../dist/utils/async-snapshot-cache.js';

let now = 1000;
let calls = 0;
let rejectNext = false;
let release;
const cache = new AsyncSnapshotCache(
  { value: 'initial' },
  async () => {
    calls++;
    if (rejectNext) {
      rejectNext = false;
      throw new Error('fixture failure\nwith details');
    }
    if (release) {
      await new Promise((resolve) => {
        const previous = release;
        release = () => {
          previous();
          resolve();
        };
      });
    }
    return { value: `loaded-${calls}` };
  },
  {
    ttlMs: 100,
    staleAfterMs: 250,
    now: () => now,
  }
);

assert.equal(cache.get().value, 'initial');
assert.equal(cache.getHealth().status, 'stale');

await cache.refresh();
assert.equal(calls, 1);
assert.equal(cache.get().value, 'loaded-1');
assert.equal(cache.getHealth().status, 'fresh');

now += 50;
await cache.refresh();
assert.equal(calls, 1, 'fresh reads must not invoke the loader');

now += 100;
release = () => {};
const first = cache.refresh();
const second = cache.refresh();
release();
await Promise.all([first, second]);
release = undefined;
assert.equal(calls, 2, 'concurrent refreshes must share one loader');

now += 300;
assert.equal(cache.getHealth().status, 'stale');

rejectNext = true;
await assert.rejects(cache.refresh(true), /fixture failure/);
assert.equal(
  cache.get().value,
  'loaded-2',
  'a failed refresh must retain the last good snapshot'
);
assert.equal(cache.getHealth().status, 'error');
assert.equal(cache.getHealth().errorSummary, 'fixture failure with details');

let recoveryCalls = 0;
let recoveryFails = false;
const recoveryCache = new AsyncSnapshotCache(
  'initial',
  async () => {
    recoveryCalls++;
    if (recoveryFails) throw new Error('temporary');
    return `good-${recoveryCalls}`;
  },
  {
    ttlMs: 10_000,
    now: () => 5000,
  }
);
await recoveryCache.refresh();
recoveryFails = true;
await assert.rejects(recoveryCache.refresh(true), /temporary/);
recoveryFails = false;
await recoveryCache.refresh();
assert.equal(
  recoveryCalls,
  3,
  'an error must retry even when the retained last-good value is still inside its TTL'
);
assert.equal(recoveryCache.get(), 'good-3');
assert.equal(recoveryCache.getHealth().status, 'fresh');

console.log('test-async-snapshot-cache: PASS');
