import assert from 'node:assert/strict';

import { renderHud } from '../../dist/render/header.js';
import { renderRateLimitLine } from '../../dist/render/lines/index.js';
import { stripAnsi } from '../../dist/render/colors.js';

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

function limits(usedPercent, { resetsIn = 6 * 86400 } = {}) {
  return {
    limit_id: 'codex',
    primary: {
      used_percent: usedPercent,
      window_minutes: 10080,
      resets_at: inSeconds(resetsIn),
    },
    secondary: null,
  };
}

/** A session that is open but has never run a turn: no token row at all. */
function readySession(rateLimits) {
  return {
    config: { model: 'gpt-5.6-sol', sandbox_mode: 'workspace-write', approval_policy: 'on-request' },
    git: { isGitRepo: false },
    project: {
      cwd: '/Users/zyb/Desktop/prj', projectName: 'prj',
      agentsMdCount: 1, rulesCount: 0, mcpCount: 6, configsCount: 0,
      extensionsCount: 0, skillsCount: 17, otherAgentSkillsCount: 0,
      hooksCount: 6, globalConfigActive: true,
    },
    sessionStart: ago(3600_000),
    collectorHealth: {},
    displayMode: 'single',
    rateLimits,
    session: {
      id: '019ff4ef-1111-2222-3333-44444444f767',
      cwd: '/Users/zyb/Desktop/prj',
      startTime: ago(3600_000),
    },
  };
}

/** A session working with agents and a plan: every row is already spoken for. */
function busySession(rateLimits) {
  const data = readySession(rateLimits);
  data.tokenUsage = {
    model_context_window: 258400,
    last_token_usage: {
      total_tokens: 131500, input_tokens: 131300,
      cached_input_tokens: 129800, output_tokens: 207,
    },
    total_token_usage: { total_tokens: 6_100_000 },
  };
  data.contextUsage = {
    used: 131500, total: 258400, percent: 48,
    inputTokens: 1500, outputTokens: 207, cachedTokens: 129800, compactCount: 0,
  };
  data.turnActivity = {
    phase: 'running-tool', since: ago(240_000),
    lastActivityAt: ago(2000), turnId: 't1',
  };
  data.toolActivity = {
    totalCalls: 63, callsByType: {}, lastUpdateTime: ago(2000),
    recentCalls: [{
      id: 'r', name: 'exec_command', status: 'running',
      timestamp: ago(12_000), target: 'rg -n pattern src',
    }],
  };
  data.planProgress = {
    totalSteps: 5, completedSteps: 2,
    steps: [{ step: 'wire the renderer into the layout ladder', status: 'in_progress' }],
  };
  data.agentActivity = {
    visibleAgentCount: 2, rootTrackingError: false,
    rows: [
      { label: 'agent-a', status: 'running', elapsedStartedAt: ago(30_000), activeDescendantCount: 0 },
      { label: 'agent-b', status: 'running', elapsedStartedAt: ago(65_000), activeDescendantCount: 1 },
    ],
  };
  return data;
}

const render = (data, width, maxLines) =>
  renderHud(data, { width, showDetails: true, layout, maxLines }).map(stripAnsi);

// ---- the calm reading is shown when there is a row for it ------------------
// The row used to require used_percent >= 70, so the weekly quota was invisible
// for the whole stretch where pacing is still possible. Measured on this
// account it ran 1% -> 48% over two days with the row never appearing, while
// the pane rendered four of its seven rows.
{
  const lines = render(readySession(limits(47)), 146, 7);
  const quota = lines.find((line) => line.includes('7d limit'));
  assert.ok(quota, 'a calm quota is stated when rows are free');
  assert.match(quota, /7d limit 47%/);
  assert.match(quota, /resets /, 'the reset is what makes the number actionable');
}

// ---- and it is the first thing to go when rows run out ---------------------
// Live state outranks a slow-moving account number. At this width the token
// row cannot absorb the quota, so keeping it would cost a whole row.
{
  const width = 100;
  const busy = render(busySession(limits(47)), width, 7);
  assert.ok(busy.length <= 7);
  assert.equal(
    busy.some((line) => line.includes('7d limit')),
    false,
    'the calm quota yields before agent, plan, or tool rows do'
  );
  assert.ok(busy.some((line) => line.includes('agent-b')), 'agents survive');
  assert.ok(busy.some((line) => line.includes('exec_command')), 'the running tool survives');

  // Given the room, the same state does state it. Ten rows is what this
  // layout needs for every live row plus the quota.
  const roomy = render(busySession(limits(47)), width, 10);
  assert.ok(
    roomy.some((line) => line.includes('7d limit 47%')),
    'a taller pane brings it back'
  );
  assert.ok(
    roomy.some((line) => line.includes('agent-b')),
    'and not by displacing anything'
  );
}

// ---- pressure is never optional -------------------------------------------
{
  const busy = render(busySession(limits(92)), 100, 7);
  const quota = busy.find((line) => line.includes('7d limit'));
  assert.ok(quota, 'a quota under pressure is not a candidate for dropping');
  assert.match(quota, /7d limit 92%/);
}

// ---- an expired window still says nothing, calm or not --------------------
// Rate limits reach the HUD through whatever snapshot the bound rollout last
// carried; a window whose reset has passed describes a period that is over.
{
  const stale = limits(47, { resetsIn: -3600 });
  assert.equal(renderRateLimitLine({ rateLimits: stale }, 146, now), null);
  assert.equal(
    renderRateLimitLine({ rateLimits: stale }, 146, now, {
      includeBelowPressure: true,
    }),
    null,
    'showing calm readings does not resurrect expired ones'
  );
  const lines = render(readySession(stale), 146, 7);
  assert.equal(lines.some((line) => line.includes('limit')), false);
}

// ---- no quota data at all is not an empty row -----------------------------
{
  assert.equal(
    renderRateLimitLine({ rateLimits: undefined }, 146, now, {
      includeBelowPressure: true,
    }),
    null
  );
}

console.log('test-quota-visibility: PASS');
