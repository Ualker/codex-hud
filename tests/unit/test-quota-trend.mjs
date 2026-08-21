import assert from 'node:assert/strict';

import { QuotaTrendTracker } from '../../dist/collectors/quota-trend.js';
import { renderRateLimitLine } from '../../dist/render/lines/index.js';
import { stripAnsi } from '../../dist/render/colors.js';

const now = Date.parse('2026-08-20T12:00:00.000Z');
const at = (offsetMs) => new Date(now + offsetMs);
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const RESETS_AT = Math.floor((now + 7 * DAY) / 1000);

function snapshot(usedPercent, resetsAt = RESETS_AT) {
  return {
    limit_id: 'codex',
    primary: {
      used_percent: usedPercent,
      window_minutes: 10080,
      resets_at: resetsAt,
    },
    secondary: null,
  };
}

// ---- the slope ------------------------------------------------------------

{
  // 50% -> 60% over two hours burns 5%/h; the remaining 40% lasts eight more
  // hours. This is the account's own failure mode: measured live it burned
  // ~24%/day and hit 100% four days before the reset, with no warning.
  const tracker = new QuotaTrendTracker();
  tracker.observe(snapshot(50), at(-2 * HOUR));
  tracker.observe(snapshot(60), at(0));
  const projection = tracker.project(snapshot(60));
  assert.ok(projection, 'two dated readings of one window give a forecast');
  assert.equal(
    projection.exhaustsAtMs,
    now + 8 * HOUR,
    'the pace extrapolates linearly from the observed pair'
  );
}

{
  // Observation order is call order, not snapshot order: the bound session
  // and the account scan feed the tracker independently.
  const tracker = new QuotaTrendTracker();
  tracker.observe(snapshot(60), at(0));
  tracker.observe(snapshot(50), at(-2 * HOUR));
  assert.equal(
    tracker.project(snapshot(60))?.exhaustsAtMs,
    now + 8 * HOUR,
    'points are paired by snapshot time, not arrival order'
  );
}

// ---- silence --------------------------------------------------------------

{
  const tracker = new QuotaTrendTracker();
  tracker.observe(snapshot(50), at(-2 * HOUR));
  assert.equal(
    tracker.project(snapshot(50)),
    null,
    'one point is a level, not a slope'
  );

  // A baseline shorter than the damping window says nothing yet: right after
  // a restart one busy turn reads as a furious burn rate.
  tracker.observe(snapshot(52), at(-2 * HOUR + 10 * 60_000));
  assert.equal(tracker.project(snapshot(52)), null, 'ten minutes is noise');

  // Flat usage is silence, not a forecast of "never".
  const flat = new QuotaTrendTracker();
  flat.observe(snapshot(50), at(-3 * HOUR));
  flat.observe(snapshot(50), at(0));
  assert.equal(flat.project(snapshot(50)), null);
}

{
  // A new resets_at is a new window; points must not straddle the boundary
  // or the first post-reset reading would inherit last week's slope.
  const tracker = new QuotaTrendTracker();
  tracker.observe(snapshot(90), at(-3 * HOUR));
  tracker.observe(snapshot(95), at(-2 * HOUR));
  const nextWindow = Math.floor((now + 14 * DAY) / 1000);
  tracker.observe(snapshot(3, nextWindow), at(0));
  assert.equal(
    tracker.project(snapshot(3, nextWindow)),
    null,
    'the rollover discards the previous window baseline'
  );
}

{
  // The projection describes the tracked window only.
  const tracker = new QuotaTrendTracker();
  tracker.observe(snapshot(50), at(-2 * HOUR));
  tracker.observe(snapshot(60), at(0));
  assert.equal(
    tracker.project(snapshot(60, RESETS_AT + 1)),
    null,
    'a snapshot naming a different window gets no forecast'
  );
  assert.equal(tracker.project(null), null);
}

// ---- the quota row --------------------------------------------------------

const layoutData = (usedPercent, exhaustsAtMs) => ({
  config: {},
  git: { isGitRepo: false },
  project: {
    cwd: '/tmp/x', projectName: 'x',
    agentsMdCount: 0, rulesCount: 0, mcpCount: 0, configsCount: 0,
    extensionsCount: 0, skillsCount: 0, otherAgentSkillsCount: 0,
    hooksCount: 0, globalConfigActive: false,
  },
  sessionStart: at(-HOUR),
  collectorHealth: {},
  displayMode: 'single',
  rateLimits: snapshot(usedPercent),
  ...(exhaustsAtMs !== undefined
    ? { quotaProjection: { exhaustsAtMs } }
    : {}),
});

const renderQuota = (usedPercent, exhaustsAtMs) =>
  stripAnsi(
    renderRateLimitLine(layoutData(usedPercent, exhaustsAtMs), 200, now, {
      includeBelowPressure: true,
    }) ?? ''
  );

{
  const line = renderQuota(62, now + 2 * DAY);
  assert.match(
    line,
    /→ empty ~08\/22/,
    'a projection that beats the reset is stated on the row'
  );
  assert.match(line, /7d limit 62%/, 'the level stays first');
}

assert.match(
  renderQuota(96, now + 5 * HOUR),
  /→ empty in 5h/,
  'under a day out the forecast is a countdown'
);

assert.doesNotMatch(
  renderQuota(49, now + 2 * DAY),
  /empty/,
  'early in the window the slope is a guess about a distant problem'
);

assert.doesNotMatch(
  renderQuota(62, now + 8 * DAY),
  /empty/,
  'an exhaustion after the reset is not a problem the user can have'
);

assert.doesNotMatch(
  renderQuota(62, now - HOUR),
  /empty/,
  'a forecast already in the past has been overtaken by reality'
);

assert.doesNotMatch(
  renderQuota(62),
  /empty/,
  'no projection, no forecast cell'
);

console.log('test-quota-trend: PASS');
