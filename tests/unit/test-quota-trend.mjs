import assert from 'node:assert/strict';

import { QuotaTrendTracker } from '../../dist/collectors/quota-trend.js';
import { renderRateLimitLine } from '../../dist/render/lines/index.js';
import { stripAnsi } from '../../dist/render/colors.js';

const now = Date.parse('2026-08-20T12:00:00.000Z');
const at = (offsetMs) => new Date(now + offsetMs);
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const RESETS_AT = Math.floor((now + 7 * DAY) / 1000);
const FIVE_H_RESETS = Math.floor((now + 4 * HOUR) / 1000);

function weeklyWindow(usedPercent, resetsAt = RESETS_AT) {
  return {
    used_percent: usedPercent,
    window_minutes: 10080,
    resets_at: resetsAt,
  };
}

function fiveHourWindow(usedPercent, resetsAt = FIVE_H_RESETS) {
  return {
    used_percent: usedPercent,
    window_minutes: 300,
    resets_at: resetsAt,
  };
}

/** The pre-0.150 snapshot shape: the weekly window alone, in primary. */
function snapshot(usedPercent, resetsAt = RESETS_AT) {
  return {
    limit_id: 'codex',
    primary: weeklyWindow(usedPercent, resetsAt),
    secondary: null,
  };
}

/** The 0.150 shape: a 5h primary with the weekly demoted to secondary. */
function dualSnapshot(fiveHourUsed, weeklyUsed, options = {}) {
  return {
    limit_id: 'codex',
    primary: fiveHourWindow(fiveHourUsed, options.fiveHourResets),
    secondary: weeklyWindow(weeklyUsed, options.weeklyResets),
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
  const projection = tracker.projectWindow(weeklyWindow(60), now);
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
    tracker.projectWindow(weeklyWindow(60), now)?.exhaustsAtMs,
    now + 8 * HOUR,
    'points are paired by snapshot time, not arrival order'
  );
}

// ---- silence --------------------------------------------------------------

{
  const tracker = new QuotaTrendTracker();
  tracker.observe(snapshot(50), at(-2 * HOUR));
  assert.equal(
    tracker.projectWindow(weeklyWindow(50), now),
    null,
    'one point is a level, not a slope'
  );

  // A baseline shorter than the damping window says nothing yet: right after
  // a restart one busy turn reads as a furious burn rate.
  tracker.observe(snapshot(52), at(-2 * HOUR + 10 * 60_000));
  assert.equal(
    tracker.projectWindow(weeklyWindow(52), now),
    null,
    'ten minutes is noise'
  );

  // Flat usage is silence, not a forecast of "never".
  const flat = new QuotaTrendTracker();
  flat.observe(snapshot(50), at(-3 * HOUR));
  flat.observe(snapshot(50), at(0));
  assert.equal(flat.projectWindow(weeklyWindow(50), now), null);
}

{
  // A new resets_at is a new window block; points must not straddle the
  // boundary or the first post-reset reading would inherit last week's slope.
  const tracker = new QuotaTrendTracker();
  tracker.observe(snapshot(90), at(-3 * HOUR));
  tracker.observe(snapshot(95), at(-2 * HOUR));
  const nextWindow = Math.floor((now + 14 * DAY) / 1000);
  tracker.observe(snapshot(3, nextWindow), at(0));
  assert.equal(
    tracker.projectWindow(weeklyWindow(3, nextWindow), now),
    null,
    'the rollover discards the previous window baseline'
  );
}

{
  // The projection describes the tracked block only.
  const tracker = new QuotaTrendTracker();
  tracker.observe(snapshot(50), at(-2 * HOUR));
  tracker.observe(snapshot(60), at(0));
  assert.equal(
    tracker.projectWindow(weeklyWindow(60, RESETS_AT + 1), now),
    null,
    'a snapshot naming a different block gets no forecast'
  );
  assert.equal(tracker.projectAll(null, now), null);
}

// ---- per-window classes ---------------------------------------------------
// Codex 0.150 swapped a 5h window into primary and demoted the weekly to
// secondary. The single-series tracker wedged on that switch: the 5h
// resets_at is always earlier than the stored weekly one, so every
// post-upgrade reading was rejected as a stale replay — measured live, four
// active days added zero points.

{
  const tracker = new QuotaTrendTracker();
  // 0.149 era: the weekly window is primary.
  tracker.observe(snapshot(50), at(-3 * HOUR));
  // 0.150 era: 5h primary, the same weekly block now secondary.
  tracker.observe(dualSnapshot(10, 55), at(-HOUR));
  tracker.observe(dualSnapshot(20, 60), at(0));

  assert.equal(
    tracker.projectWindow(weeklyWindow(60), now)?.exhaustsAtMs,
    now + 12 * HOUR,
    'the weekly baseline keeps building across its demotion to secondary'
  );
  assert.equal(
    tracker.projectWindow(fiveHourWindow(20), now)?.exhaustsAtMs,
    now + 8 * HOUR,
    'the 5h series forms instead of being rejected against the weekly resets_at'
  );
}

{
  // Blocks end independently: a 5h rollover must not touch the weekly pair.
  const tracker = new QuotaTrendTracker();
  tracker.observe(dualSnapshot(80, 50), at(-2 * HOUR));
  tracker.observe(dualSnapshot(95, 60), at(-HOUR));
  const nextFiveHour = FIVE_H_RESETS + 5 * 3600;
  tracker.observe(
    dualSnapshot(3, 62, { fiveHourResets: nextFiveHour }),
    at(0)
  );
  assert.equal(
    tracker.projectWindow(fiveHourWindow(3, nextFiveHour), now),
    null,
    'the 5h rollover discards only the 5h baseline'
  );
  assert.ok(
    tracker.projectWindow(weeklyWindow(62), now),
    'the weekly baseline is untouched by a 5h block change'
  );
}

{
  // projectAll pairs every reported window with its own forecast.
  const tracker = new QuotaTrendTracker();
  tracker.observe(dualSnapshot(40, 50), at(-2 * HOUR));
  tracker.observe(dualSnapshot(60, 60), at(0));
  const all = tracker.projectAll(dualSnapshot(60, 60), now);
  assert.equal(all?.[300]?.exhaustsAtMs, now + 4 * HOUR);
  assert.equal(all?.[10080]?.exhaustsAtMs, now + 8 * HOUR);
}

// ---- the shared baseline --------------------------------------------------
// The quota is account state; per-process baselines let two panes forecast
// the same account differently (measured live: `empty ~08/23` beside
// `empty in 21h30m`). The state file makes every HUD read one pair — and
// keeps the baseline across --reload.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-trend-'));
  const stateFilePath = path.join(dir, 'quota-trend.json');
  try {
    // HUD A sees the early reading and persists it.
    const hudA = new QuotaTrendTracker({ stateFilePath });
    hudA.observe(snapshot(50), at(-2 * HOUR));

    // HUD B starts later and sees only the fresh reading; the persisted
    // first point completes its baseline immediately.
    const hudB = new QuotaTrendTracker({ stateFilePath });
    hudB.observe(snapshot(60), at(0));
    assert.equal(
      hudB.projectWindow(weeklyWindow(60), now)?.exhaustsAtMs,
      now + 8 * HOUR,
      'a second HUD adopts the persisted first point'
    );

    // HUD A converges to the same forecast through its periodic re-read,
    // without ever observing the later snapshot itself.
    assert.equal(
      hudA.projectWindow(weeklyWindow(60), now)?.exhaustsAtMs,
      now + 8 * HOUR,
      'the first HUD reads the other pane\'s later point back'
    );

    // A restart (fresh instance, same file) starts with the full baseline.
    const reloaded = new QuotaTrendTracker({ stateFilePath });
    assert.equal(
      reloaded.projectWindow(weeklyWindow(60), now)?.exhaustsAtMs,
      now + 8 * HOUR,
      'a reload does not restart the baseline clock'
    );

    // The rollover supersedes the persisted block for every reader.
    const nextWindow = Math.floor((now + 14 * DAY) / 1000);
    hudB.observe(snapshot(2, nextWindow), at(HOUR));
    hudB.observe(snapshot(4, nextWindow), at(2 * HOUR));
    const postRollover = new QuotaTrendTracker({ stateFilePath });
    assert.equal(
      postRollover.projectWindow(weeklyWindow(60), now),
      null,
      'points from a finished block are gone for good'
    );

    // A stale replay from the finished block must not displace the live one.
    hudB.observe(snapshot(90), at(-HOUR));
    assert.equal(
      JSON.parse(fs.readFileSync(stateFilePath, 'utf8')).windows['10080']
        .resetsAt,
      nextWindow,
      'an older block\'s reading cannot overwrite the live baseline'
    );

    // A corrupted file is no baseline at all — and never a crash.
    fs.writeFileSync(stateFilePath, '{not json');
    const corrupted = new QuotaTrendTracker({ stateFilePath });
    corrupted.observe(snapshot(50), at(-2 * HOUR));
    corrupted.observe(snapshot(60), at(0));
    assert.equal(
      corrupted.projectWindow(weeklyWindow(60), now)?.exhaustsAtMs,
      now + 8 * HOUR,
      'a corrupt file degrades to in-memory tracking and gets rewritten'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  // The unversioned pre-0.150 file is the wedged single-series state; it is
  // discarded, not merged, and the next write upgrades the file in place.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-trend-v1-'));
  const stateFilePath = path.join(dir, 'quota-trend.json');
  try {
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        resetsAt: RESETS_AT,
        first: { usedPercent: 14, atMs: now - 4 * DAY },
        latest: { usedPercent: 14, atMs: now - 4 * DAY },
      })
    );
    const tracker = new QuotaTrendTracker({ stateFilePath });
    tracker.observe(snapshot(50), at(-2 * HOUR));
    tracker.observe(snapshot(60), at(0));
    assert.equal(
      tracker.projectWindow(weeklyWindow(60), now)?.exhaustsAtMs,
      now + 8 * HOUR,
      'the stale pre-0.150 point must not stretch the fresh baseline'
    );
    const written = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
    assert.equal(written.version, 2, 'the file is rewritten in the v2 shape');
    assert.equal(written.windows['10080'].resetsAt, RESETS_AT);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  // No path configured: pure memory, no files anywhere.
  const tracker = new QuotaTrendTracker();
  tracker.observe(snapshot(50), at(-2 * HOUR));
  tracker.observe(snapshot(60), at(0));
  assert.ok(tracker.projectWindow(weeklyWindow(60), now));
}

// ---- the quota row --------------------------------------------------------

const layoutData = (rateLimits, quotaProjections) => ({
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
  rateLimits,
  ...(quotaProjections ? { quotaProjections } : {}),
});

const renderQuota = (usedPercent, exhaustsAtMs) =>
  stripAnsi(
    renderRateLimitLine(
      layoutData(
        snapshot(usedPercent),
        exhaustsAtMs !== undefined
          ? { 10080: { exhaustsAtMs } }
          : undefined
      ),
      200,
      now,
      { includeBelowPressure: true }
    ) ?? ''
  );

{
  const line = renderQuota(62, now + 2 * DAY);
  assert.match(
    line,
    /→ 7d empty ~08\/22/,
    'a projection that beats the reset is stated on the row, named for its window'
  );
  assert.match(line, /7d limit 62%/, 'the level stays first');
}

assert.match(
  renderQuota(96, now + 5 * HOUR),
  /→ 7d empty in 5h/,
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

{
  // Both 0.150 windows on one row, each with its own labeled forecast, the
  // facts before the forecasts.
  const line = stripAnsi(
    renderRateLimitLine(
      layoutData(dualSnapshot(91, 62), {
        300: { exhaustsAtMs: now + 30 * 60_000 },
        10080: { exhaustsAtMs: now + 2 * DAY },
      }),
      200,
      now,
      { includeBelowPressure: true }
    ) ?? ''
  );
  assert.match(
    line,
    /5h limit 91%.*7d limit 62%.*→ 5h empty in 30m.*→ 7d empty ~08\/22/,
    `dual windows carry dual labeled forecasts: ${line}`
  );
}

console.log('test-quota-trend: PASS');
