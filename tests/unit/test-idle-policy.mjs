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
  // Fifteen seconds: Codex's own edits refresh git when a tool call
  // completes, so the poll only covers edits made outside the session.
  assert.equal(plan.gitMs, 15_000);
  assert.equal(plan.agentsMs, 1_000);
  assert.equal(plan.rolloutFallbackMs, 2_000);
  assert.equal(plan.overviewMs, 5_000);
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
  assert.equal(plan.overviewMs, 30_000);
}

// Displaying the overview used to veto deep idle outright, on the grounds
// that someone must be watching it. Nothing tells the HUD whether that is
// still true — switching tmux window or detaching leaves the dashboard up and
// unwatched — and the assumption cost 2.8x an idle single view for as long as
// the mode was left on. What the fleet is doing decides instead, and the
// caller folds the listed sessions into hasActiveWork.
{
  const plan = planCadence({
    ...base,
    overviewVisible: true,
    lastActivityMs: nowMs - DEEP_IDLE_AFTER_MS * 2,
  });
  assert.equal(plan.deepIdle, true, 'a quiet fleet left on screen backs off');
  assert.equal(plan.renderMs, 3000);
  assert.equal(plan.overviewMs, 30_000);
}

// A fleet that is working keeps the dashboard live no matter how long since
// the last keypress: watching sessions run is exactly what it is for.
{
  const plan = planCadence({
    ...base,
    overviewVisible: true,
    hasActiveWork: true,
    lastActivityMs: nowMs - DEEP_IDLE_AFTER_MS * 2,
  });
  assert.equal(plan.deepIdle, false);
  assert.equal(plan.renderMs, 500);
  assert.equal(plan.overviewMs, 5_000);
}

// Recent interaction keeps the base cadence for an idle fleet too.
{
  const plan = planCadence({ ...base, overviewVisible: true });
  assert.equal(plan.deepIdle, false);
  assert.equal(plan.renderMs, 1500);
  assert.equal(plan.overviewMs, 5_000);
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
