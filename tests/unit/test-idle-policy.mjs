import assert from 'node:assert/strict';

import {
  DEEP_IDLE_AFTER_MS,
  planCadence,
} from '../../dist/utils/idle-policy.js';

const nowMs = Date.parse('2026-08-06T12:00:00');
const base = {
  nowMs,
  lastActivityMs: nowMs - 1000,
  hasActiveWork: false,
  bound: true,
  overviewVisible: false,
  gitIsRepo: true,
};

// Recently active and bound: the historical base cadence.
{
  const plan = planCadence(base);
  assert.equal(plan.deepIdle, false);
  assert.equal(plan.renderMs, 1500);
  assert.equal(plan.gitMs, 5_000);
  assert.equal(plan.agentsMs, 1_000);
  assert.equal(plan.rolloutFallbackMs, 2_000);
}

// Active work always renders at the fast interval, regardless of timestamps.
{
  const plan = planCadence({
    ...base,
    hasActiveWork: true,
    lastActivityMs: nowMs - DEEP_IDLE_AFTER_MS * 3,
  });
  assert.equal(plan.deepIdle, false);
  assert.equal(plan.renderMs, 500);
}

// Quiet past the threshold: every safety-net cadence stretches.
{
  const plan = planCadence({
    ...base,
    lastActivityMs: nowMs - DEEP_IDLE_AFTER_MS,
  });
  assert.equal(plan.deepIdle, true, 'the threshold itself is deep idle');
  assert.equal(plan.renderMs, 3000);
  assert.equal(plan.gitMs, 60_000);
  assert.equal(plan.agentsMs, 5_000);
  assert.equal(plan.rolloutFallbackMs, 10_000);
}

// The overview dashboard is being watched: never deep idle.
{
  const plan = planCadence({
    ...base,
    overviewVisible: true,
    lastActivityMs: nowMs - DEEP_IDLE_AFTER_MS * 2,
  });
  assert.equal(plan.deepIdle, false);
  assert.equal(plan.renderMs, 1500);
}

// Unbound HUDs keep their slower render interval before deep idle kicks in.
{
  const plan = planCadence({ ...base, bound: false });
  assert.equal(plan.renderMs, 2500);
}

// A non-repo cwd stops paying one doomed git spawn per five seconds even at
// the base cadence; everything else stays fast.
{
  const plan = planCadence({ ...base, gitIsRepo: false });
  assert.equal(plan.deepIdle, false);
  assert.equal(plan.gitMs, 60_000);
  assert.equal(plan.agentsMs, 1_000);
}

// A wake signal one millisecond ago ends deep idle immediately.
{
  const plan = planCadence({ ...base, lastActivityMs: nowMs - 1 });
  assert.equal(plan.deepIdle, false);
}

console.log('test-idle-policy: PASS');
