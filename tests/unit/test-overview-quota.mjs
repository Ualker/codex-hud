import assert from 'node:assert/strict';

import { renderHud } from '../../dist/render/header.js';
import { stripAnsi } from '../../dist/render/colors.js';

const WIDTH = 146;
const layout = {
  mode: 'expanded',
  showSeparators: false,
  showDuration: true,
  showContextBreakdown: true,
  barWidth: 12,
};

const now = Date.now();
const ago = (ms) => new Date(now - ms);
const inSeconds = (s) => Math.floor(now / 1000) + s;

const limits = (usedPercent) => ({
  limit_id: 'codex',
  primary: {
    used_percent: usedPercent,
    window_minutes: 10080,
    resets_at: inSeconds(6 * 86400),
  },
  secondary: null,
});

const session = (id, over = {}) => ({
  id,
  cwd: '/Users/zyb/Desktop/prj',
  projectName: 'prj',
  lastActivityAt: ago(60_000),
  turnActivity: { phase: 'idle', since: ago(120_000), lastActivityAt: ago(60_000) },
  contextUsage: { used: 1, total: 2, percent: 50 },
  ...over,
});

const view = (over, maxLines = 7) =>
  renderHud(
    {
      config: {},
      git: { isGitRepo: false },
      project: { cwd: '/Users/zyb/Desktop/prj', projectName: 'prj' },
      collectorHealth: {},
      displayMode: 'overview',
      ...over,
    },
    { width: WIDTH, showDetails: true, layout, maxLines }
  ).map(stripAnsi);

const threeSessions = [
  session('019ff4e2-aaaa-7aaa-8aaa-aaaaaaaaaaaa', { tmuxSession: 'codex-hud-prj-1' }),
  session('019ff48b-bbbb-7bbb-8bbb-bbbbbbbbbbbb', { tmuxSession: 'codex-hud-prj-2' }),
  session('019ff4ef-cccc-7ccc-8ccc-cccccccccccc', { tmuxSession: 'codex-hud-prj-3' }),
];

// ---- the fleet-wide number belongs on the fleet view ----------------------
// Measured live: three sessions filled three of seven rows and the remaining
// four were blank, while the one number that describes every row at once —
// the account's weekly quota — appeared only in the single view.
{
  const lines = view({
    overview: { sessions: threeSessions, updatedAt: new Date(now) },
    rateLimits: limits(47),
  });
  assert.equal(lines.length, 4, 'three sessions plus the quota');
  assert.ok(lines[3].includes('7d 53% left'));
  assert.ok(lines[0].includes('codex-hud-prj-1'), 'sessions keep the top of the pane');
}

// ---- sessions outrank a calm quota ----------------------------------------
{
  const many = Array.from({ length: 7 }, (_, i) =>
    session(`019ff4e2-aaaa-7aaa-8aaa-00000000000${i}`, { tmuxSession: `codex-hud-prj-${i}` })
  );
  const lines = view({
    overview: { sessions: many, updatedAt: new Date(now) },
    rateLimits: limits(47),
  });
  assert.equal(lines.length, 7);
  assert.equal(
    lines.some((line) => /\b7d \d+% left/.test(line)),
    false,
    'a calm quota only fills a row nothing else wanted'
  );
}

// ---- a quota under pressure takes its row anyway --------------------------
// Same rule the single view follows: pressure is not a candidate for dropping.
{
  const many = Array.from({ length: 7 }, (_, i) =>
    session(`019ff4e2-aaaa-7aaa-8aaa-00000000000${i}`, { tmuxSession: `codex-hud-prj-${i}` })
  );
  const lines = view({
    overview: { sessions: many, updatedAt: new Date(now) },
    rateLimits: limits(92),
  });
  assert.ok(
    lines[0].includes('7d 8% left'),
    'the warning leads, because the bottom of a full list is what gets clipped'
  );
  assert.ok(
    lines.slice(1).every((line) => line.includes('prj')),
    'and nothing else is displaced'
  );
}

// ---- the first toggle is not a blank screen -------------------------------
// The overview cache is cold until the mode is entered, so the scan is on
// screen for a few seconds every time. The bound session needs no scan.
{
  const lines = view({
    overview: undefined,
    session: {
      id: '019ff4e2-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
      cwd: '/Users/zyb/Desktop/prj',
      model: 'gpt-5.6-sol',
      startTime: ago(3600_000),
    },
    turnActivity: { phase: 'running-tool', since: ago(5000), lastActivityAt: ago(1000) },
    contextUsage: { used: 1, total: 2, percent: 50 },
    overviewSelfSessionId: '019ff4e2-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
  });
  assert.ok(lines[0].includes('prj'), 'the session this HUD is bound to is listed at once');
  assert.ok(lines[0].includes('▸'), 'and marked as the current one');
  assert.ok(
    lines.some((line) => line.includes('Looking for other sessions')),
    'while the scan for the rest is still described'
  );
}

// ---- a finished scan that found nothing still says so ---------------------
{
  const lines = view({ overview: { sessions: [], updatedAt: new Date(now) } });
  assert.deepEqual(lines, ['No active sessions']);
}

// ---- an unbound HUD has nothing to show early -----------------------------
{
  const lines = view({ overview: undefined });
  assert.deepEqual(lines, ['Looking for sessions…']);
}

console.log('test-overview-quota: PASS');
