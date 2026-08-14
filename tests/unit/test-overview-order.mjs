import assert from 'node:assert/strict';

import { compareOverviewSessions } from '../../dist/collectors/overview-order.js';

const now = Date.now();
const ago = (ms) => new Date(now - ms);

function item(name, { phase = 'idle', ageMinutes = 1, percent } = {}) {
  return {
    id: name,
    projectName: name,
    lastActivityAt: ago(ageMinutes * 60_000),
    turnActivity: phase
      ? { phase, since: ago(60_000), lastActivityAt: ago(ageMinutes * 60_000) }
      : undefined,
    contextUsage:
      percent === undefined ? undefined : { used: 1, total: 2, percent },
  };
}

const order = (items) =>
  [...items].sort(compareOverviewSessions).map((entry) => entry.id);

// Something running always leads: it is the only row whose state can change
// while you look at it.
assert.deepEqual(
  order([
    item('idle-recent', { ageMinutes: 0 }),
    item('running-old', { phase: 'running-tool', ageMinutes: 45 }),
    item('thinking', { phase: 'thinking', ageMinutes: 50 }),
  ]).slice(0, 2).sort(),
  ['running-old', 'thinking'],
  'working sessions outrank an idle one no matter how recent'
);

assert.deepEqual(
  order([
    item('running-recent', { phase: 'running-tool', ageMinutes: 0 }),
    item('approval-old', { phase: 'awaiting-approval', ageMinutes: 90 }),
  ]),
  ['approval-old', 'running-recent'],
  'a session blocked on the user leads ordinary background work'
);

// Recency outranks context fullness. Ranking the fullest session first pushed
// the one you touched a minute ago below an older, fuller one — and on a
// seven-row pane that means below the fold.
assert.deepEqual(
  order([
    item('older-but-full', { ageMinutes: 25, percent: 95 }),
    item('just-left', { ageMinutes: 1, percent: 10 }),
  ]),
  ['just-left', 'older-but-full'],
  'the session you just left leads the fuller one'
);

// Fullness remains the tiebreak when recency cannot separate two rows.
{
  const sameAge = [
    item('emptier', { ageMinutes: 5, percent: 20 }),
    item('fuller', { ageMinutes: 5, percent: 88 }),
  ];
  assert.deepEqual(
    order(sameAge),
    ['fuller', 'emptier'],
    'equal recency falls through to how much context is spent'
  );
}

// A session open but never run has neither a turn phase nor an activity time.
// Both fall back to zero, which must sort it last rather than to the top.
{
  const neverStarted = { id: 'blank', projectName: 'blank', neverStarted: true };
  assert.deepEqual(
    order([neverStarted, item('idle', { ageMinutes: 90 })]),
    ['idle', 'blank'],
    'missing timestamps do not outrank a real one'
  );
  assert.deepEqual(
    order([
      neverStarted,
      item('running', { phase: 'running-tool', ageMinutes: 200 }),
      item('idle', { ageMinutes: 90, percent: 99 }),
    ]),
    ['running', 'idle', 'blank'],
    'and it stays below every session with real history'
  );
}

// The comparator must be a consistent ordering, or Array#sort is free to do
// anything at all with it.
{
  const items = [
    item('a', { phase: 'running-tool', ageMinutes: 3, percent: 50 }),
    item('b', { ageMinutes: 3, percent: 50 }),
    item('c', { ageMinutes: 1, percent: 10 }),
    item('d', { phase: 'responding', ageMinutes: 9 }),
  ];
  for (const left of items) {
    assert.equal(compareOverviewSessions(left, left), 0, 'reflexive');
    for (const right of items) {
      // `|| 0` normalizes -0, which strict equality would otherwise reject.
      assert.equal(
        Math.sign(compareOverviewSessions(left, right)) || 0,
        -Math.sign(compareOverviewSessions(right, left)) || 0,
        `antisymmetric for ${left.id}/${right.id}`
      );
    }
  }
}

console.log('test-overview-order: PASS');
