import assert from 'node:assert/strict';
import { createParseQueue } from '../../dist/utils/parse-queue.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let calls = 0;
const parseFn = async () => {
  calls += 1;
  await delay(20);
  return calls;
};

const run = createParseQueue(parseFn);

const first = run();
await delay(5);
const second = run();

const result1 = await first;
const result2 = await second;

assert.equal(calls, 2, 'queues one extra parse during inflight');
assert.equal(result1, 2, 'returns latest parse result');
assert.equal(result2, 2, 'returns latest parse result for queued call');

const result3 = await run();
assert.equal(calls, 3, 'new call after height triggers fresh parse');
assert.equal(result3, 3, 'returns new parse result');

// A rejected parse must not wedge the queue: later calls re-run parseFn.
let flakyCalls = 0;
const flaky = createParseQueue(async () => {
  flakyCalls += 1;
  if (flakyCalls === 1) {
    throw new Error('boom');
  }
  return flakyCalls;
});

await assert.rejects(flaky(), /boom/, 'first call surfaces the parse error');
const recovered = await flaky();
assert.equal(flakyCalls, 2, 'parseFn runs again after a rejection');
assert.equal(recovered, 2, 'queue recovers with a fresh parse result');

// Rejection with a queued caller: both see the error, then the queue recovers.
let phase = 0;
const transient = createParseQueue(async () => {
  phase += 1;
  await delay(20);
  if (phase === 1) {
    throw new Error('transient');
  }
  return phase;
});

const firstTransient = transient();
await delay(5);
const queuedTransient = transient();
await assert.rejects(firstTransient, /transient/);
await assert.rejects(queuedTransient, /transient/);
const afterTransient = await transient();
assert.ok(afterTransient >= 2, 'queue keeps parsing after a shared rejection');

console.log('test-parse-queue: PASS');
