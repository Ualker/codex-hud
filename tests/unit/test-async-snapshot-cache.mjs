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
// Never-run is `pending`, not `stale`. Reporting it as stale made every HUD
// start print "project scan not refreshing · git status not refreshing" for
// the ~0.6s before the first collector round finished.
assert.equal(cache.getHealth().status, 'pending');
assert.equal(
  cache.getHealth().lastSuccessAt,
  undefined,
  'a pending collector has no success to date'
);

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
let recoveryNow = 5000;
const recoveryCache = new AsyncSnapshotCache(
  'initial',
  async () => {
    recoveryCalls++;
    if (recoveryFails) throw new Error('temporary');
    return `good-${recoveryCalls}`;
  },
  {
    ttlMs: 10_000,
    errorRetryMs: 1000,
    now: () => recoveryNow,
  }
);
await recoveryCache.refresh();
recoveryFails = true;
await assert.rejects(recoveryCache.refresh(true), /temporary/);
recoveryFails = false;

// Inside the error-retry window the cache serves the last-good value instead
// of hammering the loader on every caller tick.
await recoveryCache.refresh();
assert.equal(
  recoveryCalls,
  2,
  'failed refreshes retry on the error cadence, not on every tick'
);
assert.equal(recoveryCache.getHealth().status, 'error');

recoveryNow += 1000;
await recoveryCache.refresh();
assert.equal(
  recoveryCalls,
  3,
  'an error must retry after errorRetryMs even when the last-good value is inside its success TTL'
);
assert.equal(recoveryCache.get(), 'good-3');
assert.equal(recoveryCache.getHealth().status, 'fresh');

const pending = [];
const switching = new AsyncSnapshotCache('initial', () => new Promise((resolve, reject) => pending.push({ resolve, reject })), { ttlMs: 100 });
const oldRequest = switching.refresh();
switching.reset('new identity');
const newRequest = switching.refresh();
pending[1].resolve('new result');
await newRequest;
pending[0].resolve('old result');
await oldRequest;
assert.equal(switching.get(), 'new result', 'an old in-flight collector cannot replace a new identity');
const oldFailure = switching.refresh(true);
switching.reset('third identity');
pending[2].reject(new Error('old directory disappeared'));
await assert.rejects(oldFailure);
assert.equal(switching.getHealth().status, 'pending', 'an old failure cannot poison a new identity');

console.log('test-async-snapshot-cache: PASS');
