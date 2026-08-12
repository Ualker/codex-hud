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

function session(id, over = {}) {
  return {
    id,
    cwd: '/Users/zyb/Desktop/prj',
    projectName: 'prj',
    lastActivityAt: ago(60_000),
    turnActivity: {
      phase: 'idle',
      since: ago(120_000),
      lastActivityAt: ago(60_000),
    },
    contextUsage: { used: 1, total: 2, percent: 50 },
    ...over,
  };
}

const view = (sessions, selfSessionId) =>
  renderHud(
    {
      config: {},
      git: { isGitRepo: false },
      project: { cwd: '/x', projectName: 'x' },
      collectorHealth: {},
      displayMode: 'overview',
      overviewSelfSessionId: selfSessionId,
      overview: { sessions, updatedAt: new Date(now) },
    },
    { width: WIDTH, showDetails: true, layout, maxLines: 12 }
  ).map(stripAnsi);

// ---- the row carries an address, not just an identifier -------------------
// Measured live with three sessions open in one project: every row read
// "prj │ Idle │ … │ 019ff4ef". The project column was the same word three
// times and the session id matches nothing the user can type, so the dashboard
// could say a session needed attention without saying which one.
{
  const lines = view([
    session('019ff4e2-aaaa-7aaa-8aaa-aaaaaaaaaaaa', {
      tmuxSession: 'codex-hud-prj-2a51592d-20260812135511-57225',
    }),
    session('019ff48b-bbbb-7bbb-8bbb-bbbbbbbbbbbb', {
      tmuxSession: 'codex-hud-prj-2a51592d-20260812151832-33905',
    }),
  ]);

  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('135511-57225'), 'the tmux session is named');
  assert.ok(lines[1].includes('151832-33905'), 'and it differs per row');
  assert.equal(
    lines[0].includes('019ff4e2'),
    false,
    'the id it replaces does not also stay'
  );
}

// The shared `codex-hud-<project>-<hash>-` prefix carries no information, so
// the truncation drops the head and keeps the part that tells rows apart.
{
  const long = 'codex-hud-a-very-long-project-name-2a51592d-20260812135511-57225';
  const lines = view([session('019ff4e2-aaaa-7aaa-8aaa-aaaaaaaaaaaa', { tmuxSession: long })]);
  assert.ok(lines[0].includes('…'), 'an over-long name is truncated');
  assert.ok(lines[0].includes('57225'), 'and the distinguishing tail survives');
  assert.equal(
    lines[0].includes('codex-hud-a-very'),
    false,
    'the shared head is what goes'
  );
}

// A session found by the rollout scan alone has no tmux binding to name.
{
  const lines = view([session('019ff4e2-aaaa-7aaa-8aaa-aaaaaaaaaaaa')]);
  assert.ok(lines[0].includes('019ff4e2'), 'the id remains the fallback');
}

// ---- the model column only exists when it separates rows ------------------
{
  const uniform = view([
    session('019ff4e2-aaaa-7aaa-8aaa-aaaaaaaaaaaa', { model: 'gpt-5.6-sol' }),
    session('019ff48b-bbbb-7bbb-8bbb-bbbbbbbbbbbb', { model: 'gpt-5.6-sol' }),
  ]);
  assert.equal(
    uniform.some((line) => line.includes('gpt-5.6-sol')),
    false,
    'one model across the fleet is the same word repeated down the pane'
  );

  const mixed = view([
    session('019ff4e2-aaaa-7aaa-8aaa-aaaaaaaaaaaa', { model: 'gpt-5.6-sol' }),
    session('019ff48b-bbbb-7bbb-8bbb-bbbbbbbbbbbb', { model: 'gpt-5.6-codex' }),
  ]);
  assert.ok(mixed[0].includes('gpt-5.6-sol'));
  assert.ok(mixed[1].includes('gpt-5.6-codex'));

  // A session with no model still occupies the column, or every column after
  // it shifts left and the table stops scanning as a table.
  const partial = view([
    session('019ff4e2-aaaa-7aaa-8aaa-aaaaaaaaaaaa', { model: 'gpt-5.6-sol' }),
    session('019ff48b-bbbb-7bbb-8bbb-bbbbbbbbbbbb', { model: 'gpt-5.6-codex' }),
    session('019ff4ef-cccc-7ccc-8ccc-cccccccccccc', { neverStarted: true }),
  ]);
  const columnStart = (line) => line.indexOf('Idle');
  assert.equal(columnStart(partial[0]), columnStart(partial[1]));
  assert.ok(partial[2].includes('--'), 'the missing model keeps its cell');
}

// ---- the marker for this HUD's own row is unaffected ----------------------
{
  const self = '019ff48b-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
  const lines = view(
    [
      session('019ff4e2-aaaa-7aaa-8aaa-aaaaaaaaaaaa', { tmuxSession: 'codex-hud-a-1' }),
      session(self, { tmuxSession: 'codex-hud-b-2' }),
    ],
    self
  );
  const marked = lines.find((line) => line.includes('▸'));
  assert.ok(marked, 'the bound row is still marked');
  assert.ok(marked.includes('codex-hud-b-2'), 'and it names its own address');
}

console.log('test-overview-address: PASS');
