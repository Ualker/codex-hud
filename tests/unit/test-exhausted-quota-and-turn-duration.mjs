import assert from 'node:assert/strict';

import { renderHud } from '../../dist/render/header.js';
import {
  renderRateLimitLine,
  renderTurnActivityLine,
  renderEnvironmentLine,
} from '../../dist/render/lines/index.js';
import { stripAnsi } from '../../dist/render/colors.js';

const now = Date.parse('2026-08-19T12:00:00.000Z');
const ago = (ms) => new Date(now - ms);

const layout = {
  mode: 'expanded',
  showSeparators: false,
  showDuration: true,
  showContextBreakdown: true,
  barWidth: 12,
};

function baseData(overrides = {}) {
  return {
    config: {
      model: 'gpt-5.6-sol',
      sandbox_mode: 'danger-full-access',
      approval_policy: 'never',
      service_tier: undefined,
    },
    git: { isGitRepo: false },
    project: {
      cwd: '/Users/zyb/Desktop/prj',
      projectName: 'prj',
      agentsMdCount: 1,
      rulesCount: 0,
      mcpCount: 6,
      configsCount: 0,
      extensionsCount: 0,
      skillsCount: 17,
      otherAgentSkillsCount: 0,
      hooksCount: 6,
      globalConfigActive: true,
    },
    sessionStart: ago(3600_000),
    collectorHealth: {},
    displayMode: 'single',
    session: {
      id: '019ff4ef-1111-2222-3333-44444444f767',
      cwd: '/Users/zyb/Desktop/prj',
      startTime: ago(3600_000),
    },
    ...overrides,
  };
}

// ---- the exhausted-quota snapshot ----------------------------------------

/**
 * What codex writes on the first turn after the weekly window is spent:
 * a different limit_id, no windows at all, and a zeroed credit pool. The
 * quota row rendered nothing for it, so the HUD went silent about quota at
 * exactly the moment quota mattered most (observed live 2026-08-19).
 */
const exhausted = {
  limit_id: 'premium',
  limit_name: null,
  primary: null,
  secondary: null,
  credits: { has_credits: false, unlimited: false, balance: '0' },
  spend_control_reached: null,
  rate_limit_reached_type: null,
};

const exhaustedLine = renderRateLimitLine(
  baseData({ rateLimits: exhausted }),
  146,
  now
);
assert.ok(
  exhaustedLine !== null,
  'a snapshot stating the credit pool is empty must not render as nothing'
);
assert.match(
  stripAnsi(exhaustedLine),
  /credits: 0/,
  'the exhausted credit pool is stated in words'
);

// The fallback is for snapshots that carry no window at all. A healthy weekly
// gauge alongside an empty credit pool is an ordinary plan shape, and a
// standing "credits: 0" beside it would be a permanent false alarm.
const withWindow = {
  limit_id: 'codex',
  primary: {
    used_percent: 42,
    window_minutes: 10080,
    resets_at: Math.floor(now / 1000) + 3 * 86400,
  },
  secondary: null,
  credits: { has_credits: false, unlimited: false, balance: '0' },
};
const withWindowLine = stripAnsi(
  renderRateLimitLine(baseData({ rateLimits: withWindow }), 146, now, {
    includeBelowPressure: true,
  }) ?? ''
);
assert.match(withWindowLine, /7d 58% left/);
assert.doesNotMatch(
  withWindowLine,
  /credits/,
  'a stated window supersedes the credit fallback'
);

// An unlimited pool is not an exhausted one.
assert.equal(
  renderRateLimitLine(
    baseData({
      rateLimits: {
        limit_id: 'premium',
        primary: null,
        secondary: null,
        credits: { has_credits: false, unlimited: true, balance: '0' },
      },
    }),
    146,
    now
  ),
  null,
  'an unlimited plan reports no credit pressure'
);

// A snapshot with nothing in it at all still renders nothing.
assert.equal(
  renderRateLimitLine(
    baseData({ rateLimits: { limit_id: 'premium', primary: null, secondary: null } }),
    146,
    now
  ),
  null,
  'absent credit information is not evidence of exhaustion'
);

// ---- last turn duration on the idle row ----------------------------------

const idleTurn = {
  phase: 'idle',
  since: ago(3 * 3600_000),
  lastActivityAt: ago(3 * 3600_000),
  lastTurnDurationMs: 272_000,
  lastTimeToFirstTokenMs: 1200,
};

const idleLine = stripAnsi(renderTurnActivityLine(idleTurn, 146, now));
assert.match(
  idleLine,
  /Idle · waiting for you/,
  'the idle row keeps saying what it always said'
);
assert.match(
  idleLine,
  /last turn 4m32s/,
  'the parsed turn duration finally reaches the screen'
);
assert.match(idleLine, /event 3h ago/, 'the freshness marker survives');

// Narrow panes give the new cell up first; the phase and freshness stay.
const narrowIdle = stripAnsi(renderTurnActivityLine(idleTurn, 40, now));
assert.doesNotMatch(
  narrowIdle,
  /last turn/,
  'the duration cell yields before the row is truncated'
);
assert.match(narrowIdle, /Idle/);
assert.ok(
  stripAnsi(renderTurnActivityLine(idleTurn, 40, now)).length <= 40,
  'the row honours its width contract'
);

// A working turn shows elapsed time in its own label; the previous turn's
// duration would be two competing numbers on one row.
assert.doesNotMatch(
  stripAnsi(
    renderTurnActivityLine(
      { ...idleTurn, phase: 'thinking', lastActivityAt: ago(2000) },
      146,
      now
    )
  ),
  /last turn/,
  'only an idle turn reports the previous turn duration'
);

// A session that has not completed a turn yet has no duration to state.
assert.doesNotMatch(
  stripAnsi(
    renderTurnActivityLine(
      { phase: 'idle', since: ago(60_000), lastActivityAt: ago(60_000) },
      146,
      now
    )
  ),
  /last turn/,
  'no fabricated duration before the first completed turn'
);

// ---- the interrupted overlay --------------------------------------------

const interruptedLine = stripAnsi(
  renderTurnActivityLine(
    {
      phase: 'interrupted',
      since: ago(20 * 60_000),
      lastActivityAt: ago(18 * 60_000),
    },
    146,
    now
  )
);
assert.match(
  interruptedLine,
  /Turn likely interrupted/,
  'a confirmed stream error reads as interrupted, not as a live spinner'
);
assert.match(
  interruptedLine,
  /event 18m ago/,
  'the silence duration stays visible next to the claim'
);

// ---- runtime hedges resolve on a complete state scan ---------------------

/**
 * A bounded first read hedges runtime facts because the skipped middle might
 * have held them. But that read scans the whole skipped span for state
 * markers, so with no malformed lines "not found" is a fact — and without
 * this, `Fast: ?` stood for 21 hours on an idle session whose file provably
 * contained no thread_settings record (observed live 2026-08-19).
 */
const boundedSession = {
  id: '019ff4ef-1111-2222-3333-44444444f767',
  cwd: '/Users/zyb/Desktop/prj',
  startTime: ago(3600_000),
  model: 'gpt-5.6-sol',
  reasoningEffort: 'max',
};

const hedged = stripAnsi(
  renderEnvironmentLine(
    baseData({ partialHistory: true, session: boundedSession }),
    146
  )
);
assert.match(
  hedged,
  /Fast: \?/,
  'an incomplete scan still hedges: the record may have been missed'
);

const resolved = stripAnsi(
  renderEnvironmentLine(
    baseData({
      partialHistory: true,
      runtimeStateComplete: true,
      session: boundedSession,
    }),
    146
  )
);
assert.match(
  resolved,
  /Fast: off/,
  'a complete scan lets the config value stand instead of hedging forever'
);
assert.doesNotMatch(resolved, /\?/, 'no hedge markers remain');

// The permission state resolves on the same evidence rather than reading
// "?" for the rest of the session.
assert.match(
  resolved,
  /\[FULL ACCESS\]/,
  'a complete scan resolves the sandbox badge from config'
);
const rows = renderHud(
  baseData({
    partialHistory: true,
    runtimeStateComplete: true,
    session: boundedSession,
  }),
  { width: 146, showDetails: true, layout, maxLines: 7 }
).map(stripAnsi);
assert.ok(
  !rows.some((row) => row.includes('?')),
  'no row is left hedging once the scan is known complete'
);

// Without the completeness signal the permission state must stay hedged: a
// bounded history really can hide a sandbox change. At this width the
// environment row survives, so the unknown is spelled there; the `[ACCESS ?]`
// badge is the same fact after that row is compressed away.
assert.match(
  hedged,
  /Sandbox: \?/,
  'an incomplete scan keeps the honest unknown'
);
// Two rows is where the environment row is compressed away and the badge
// moves up to row 1 — the geometry the badge exists for.
const narrowHedged = renderHud(
  baseData({ partialHistory: true, session: boundedSession }),
  { width: 60, showDetails: true, layout, maxLines: 2 }
).map(stripAnsi);
assert.ok(
  narrowHedged.some((row) => row.includes('[ACCESS ?]')),
  'the compressed layout carries the unknown as a badge'
);
const narrowResolved = renderHud(
  baseData({
    partialHistory: true,
    runtimeStateComplete: true,
    session: boundedSession,
  }),
  { width: 60, showDetails: true, layout, maxLines: 2 }
).map(stripAnsi);
assert.ok(
  narrowResolved.some((row) => row.includes('[FULL ACCESS]')),
  'a complete scan resolves that badge too'
);

// ---- codex 0.150+: the 5h window spent, its windows retained ---------------
// Measured 2026-08-31 09:31: the 5h window read 100%, one second later the
// windowless "premium" snapshot arrived, and the reset time ("try again at
// 9:18 PM" on the Codex pane) left the HUD for the whole 3h47m.
{
  const retained = {
    ...exhausted,
    limit_id: 'codex',
    primary: {
      used_percent: 100,
      window_minutes: 300,
      resets_at: Math.floor(now / 1000) + 3 * 3600 + 47 * 60,
    },
    secondary: {
      used_percent: 31,
      window_minutes: 10080,
      resets_at: Math.floor(now / 1000) + 6 * 86400,
    },
    windowsRetained: true,
  };
  const alertRow = stripAnsi(
    renderRateLimitLine(baseData({ rateLimits: retained }), 146, now) ?? ''
  );
  assert.match(alertRow, /^5h 0% left/, `the spent window leads the row: ${alertRow}`);
  assert.match(alertRow, /resets in 3h47m/, 'with the moment work can resume');
  assert.match(alertRow, /credits: 0/, 'and the exhaustion stated beside it');
  assert.doesNotMatch(alertRow, /7d/, 'the calm weekly reading waits for a spare row');
  const calmRow = stripAnsi(
    renderRateLimitLine(baseData({ rateLimits: retained }), 146, now, {
      includeBelowPressure: true,
    }) ?? ''
  );
  assert.match(calmRow, /7d 69% left/, `the weekly window rides along when there is room: ${calmRow}`);
}

console.log('test-exhausted-quota-and-turn-duration: PASS');
