import assert from 'node:assert/strict';

import { renderHud } from '../../dist/render/header.js';
import { fitLinesToViewport } from '../../dist/render/index.js';
import { stripAnsi } from '../../dist/render/colors.js';

const WIDTH = 146;
const HEIGHT = 7;
const layout = {
  mode: 'expanded',
  showSeparators: false,
  showDuration: true,
  showContextBreakdown: true,
  barWidth: 12,
};

const now = Date.now();
const ago = (ms) => new Date(now - ms);

function session(index, { phase = 'idle', ageMinutes = index + 1 } = {}) {
  return {
    id: `019f${String(index).padStart(4, '0')}-aaaa-7aaa-8aaa-aaaaaaaaaaaa`,
    cwd: `/Users/zyb/Desktop/proj-${index}`,
    projectName: `proj-${index}`,
    lastActivityAt: ago(ageMinutes * 60_000),
    turnActivity: {
      phase,
      since: ago(100_000),
      lastActivityAt: ago(ageMinutes * 60_000),
    },
    contextUsage: { used: 1, total: 2, percent: 50 },
  };
}

function view(sessions, selfSessionId) {
  const data = {
    config: {},
    git: { isGitRepo: false },
    project: { cwd: '/x', projectName: 'x' },
    collectorHealth: {},
    displayMode: 'overview',
    overviewSelfSessionId: selfSessionId,
    overview: { sessions },
  };
  const rendered = renderHud(data, {
    width: WIDTH,
    showDetails: true,
    layout,
    maxLines: HEIGHT,
  });
  return fitLinesToViewport(rendered, HEIGHT, WIDTH).map(stripAnsi);
}

// The viewport keeps the first `maxLines` rows and stamps "+N hidden" onto the
// last of them. With enough sessions open the bound row fell off the end, so
// the dashboard listed every session except the one you were looking at.
{
  const sessions = Array.from({ length: 12 }, (_, index) => session(index));
  const self = sessions[11].id;
  const lines = view(sessions, self);

  assert.equal(lines.length, HEIGHT);
  const selfRow = lines.find((line) => line.includes('proj-11'));
  assert.ok(selfRow, 'the bound session is listed even when it sorts last');
  assert.ok(selfRow.includes('▸'), 'and still carries its marker');
  assert.equal(
    selfRow.includes('hidden'),
    false,
    'the rescued row is not the one the indicator truncates'
  );
  assert.match(
    lines[lines.length - 1],
    /\+\d+ hidden/,
    'the count of what is still hidden stays honest'
  );
}

// Rows that already fit are left exactly as the sort produced them.
{
  const sessions = Array.from({ length: 4 }, (_, index) => session(index));
  const lines = view(sessions, sessions[3].id);
  assert.deepEqual(
    lines.map((line) => line.match(/proj-\d+/)[0]),
    ['proj-0', 'proj-1', 'proj-2', 'proj-3'],
    'no reordering happens when nothing would be hidden'
  );
}

// A session that is working still leads, rescue or not.
{
  const sessions = [
    session(0, { phase: 'running-tool', ageMinutes: 20 }),
    ...Array.from({ length: 11 }, (_, index) => session(index + 1)),
  ];
  const lines = view(sessions, sessions[11].id);
  assert.match(lines[0], /proj-0/, 'the working session keeps the top row');
  assert.ok(
    lines.some((line) => line.includes('proj-11') && line.includes('▸')),
    'and the bound session is still rescued below it'
  );
}

// Nothing to rescue when the HUD is not bound to any listed session.
{
  const sessions = Array.from({ length: 12 }, (_, index) => session(index));
  const lines = view(sessions, undefined);
  assert.match(lines[0], /proj-0/);
  assert.equal(
    lines.some((line) => line.includes('▸')),
    false,
    'an unbound overview marks nothing'
  );
}

// The overview snapshot refreshes asynchronously, so the very first toggle
// paints before any scan has finished. Reporting "No active sessions" there
// states as fact something not yet known — the same mistake as calling a
// collector stale before its first run.
{
  const empty = (overview) =>
    stripAnsi(
      renderHud(
        {
          config: {},
          git: { isGitRepo: false },
          project: { cwd: '/x', projectName: 'x' },
          collectorHealth: {},
          displayMode: 'overview',
          overview,
        },
        { width: WIDTH, showDetails: true, layout, maxLines: HEIGHT }
      )[0]
    );

  assert.match(
    empty({ sessions: [], updatedAt: new Date(0) }),
    /Looking for sessions/,
    'before the first scan completes the HUD says it is still looking'
  );
  assert.match(
    empty({ sessions: [], updatedAt: new Date(now) }),
    /No active sessions/,
    'a completed scan that found nothing may say so'
  );
  assert.match(
    empty(undefined),
    /Looking for sessions/,
    'no snapshot at all is also not evidence of absence'
  );
}

console.log('test-overview-self-visibility: PASS');
