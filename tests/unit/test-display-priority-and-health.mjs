import assert from 'node:assert/strict';

import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { renderHud } from '../../dist/render/header.js';
import {
  renderEnvironmentLine,
} from '../../dist/render/lines/environment-line.js';
import {
  renderHealthLine,
  renderRateLimitLine,
  renderTurnActivityLine,
} from '../../dist/render/lines/activity-line.js';

const now = Date.parse('2026-07-30T12:00:10.000Z');
const data = {
  config: {
    model: 'gpt-5.6-sol',
    approval_policy: 'never',
    sandbox_mode: 'danger-full-access',
    service_tier: 'priority',
    mcp_servers: Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [
        `server-${index}`,
        { enabled: true },
      ])
    ),
  },
  git: {
    branch: 'main',
    isDirty: false,
    isGitRepo: true,
    ahead: 0,
    behind: 0,
    modified: 0,
    added: 0,
    deleted: 0,
    untracked: 0,
  },
  project: {
    cwd: '/tmp/中文项目',
    projectName: '中文项目',
    agentsMdCount: 1,
    hasCodexDir: true,
    instructionsMdCount: 0,
    rulesCount: 2,
    mcpCount: 6,
    configsCount: 2,
    extensionsCount: 6,
    skillsCount: 17,
    otherAgentSkillsCount: 11,
    hooksCount: 6,
    globalConfigActive: true,
    workMode: 'development',
  },
  sessionStart: new Date(now - 60_000),
  session: {
    id: '019b1111-a111-7111-8111-111111111111',
    rolloutPath: '/tmp/rollout.jsonl',
    startTime: new Date(now - 60_000),
    cwd: '/tmp/中文项目',
    cliVersion: '0.146.0',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
    serviceTier: 'priority',
  },
  turnActivity: {
    phase: 'thinking',
    turnId: 'turn-1',
    since: new Date(now - 42_000),
    lastActivityAt: new Date(now - 8_000),
  },
  rateLimits: {
    primary: {
      used_percent: 82,
      window_minutes: 300,
      resets_at: now / 1000 + 3600,
    },
    secondary: {
      used_percent: 91,
      window_minutes: 10_080,
      resets_at: now / 1000 + 7 * 24 * 3600,
    },
  },
  collectorHealth: {
    git: {
      status: 'stale',
      lastAttemptAt: new Date(now),
      lastSuccessAt: new Date(now - 18_000),
    },
    rollout: {
      status: 'error',
      lastAttemptAt: new Date(now),
      lastSuccessAt: new Date(now - 5000),
      errorSummary: 'private details must not render',
    },
  },
  protocolHealth: {
    unknownTopLevelTypes: { future: 1 },
    unknownResponseTypes: {},
    unknownEventTypes: {},
  },
  displayMode: 'single',
};

const environment = stripAnsi(renderEnvironmentLine(data, 90));
assert.match(environment, /^\[FULL ACCESS\]/);
assert.doesNotMatch(
  environment,
  /Approval: |Sandbox: /,
  'the badge already states the whole permission mode'
);
assert.ok(
  environment.indexOf('[FULL ACCESS]') < environment.indexOf('MCP configured:'),
  'security state must precede inventory counts'
);
assert.doesNotMatch(environment, /Other-agent skills/);
assert.ok(visualLength(renderEnvironmentLine(data, 90)) <= 90);

const turn = stripAnsi(renderTurnActivityLine(data.turnActivity, 80, now));
assert.match(turn, /Thinking 42s/);
assert.match(turn, /event 8s ago/);

const rate = stripAnsi(renderRateLimitLine(data, 80, now));
assert.match(rate, /5h limit 82%/);
assert.match(rate, /7d limit 91%/);
assert.match(rate, /resets/);

// A quota snapshot only describes the window it was written in. Rollouts keep
// replaying their last token_count forever, so an idle or resumed session used
// to advertise a percentage from a window that had already reset — observed
// live as "7d limit 84% | resets 08/05" a week after that date.
assert.equal(
  renderRateLimitLine(data, 80, now + 8 * 24 * 3600 * 1000),
  null,
  'a snapshot whose windows have all reset states nothing about the current one'
);
const partiallyExpired = stripAnsi(
  renderRateLimitLine(data, 80, now + 2 * 3600 * 1000)
);
assert.doesNotMatch(partiallyExpired, /5h limit/, 'the reset window drops out');
assert.match(partiallyExpired, /7d limit 91%/, 'the live window survives');

const health = stripAnsi(renderHealthLine(data, 100, now));
// Collector keys are internal names; the health row is the only place a user
// meets them, so each reads as a phrase rather than a status enum.
assert.match(health, /git status 18s old/);
assert.match(health, /session log unavailable/);
assert.match(health, /1 unrecognized Codex record\b/);
assert.doesNotMatch(health, /private details/);

// A collector that has not finished its first run is `pending`, not a fault.
// Reporting it made every HUD start show "project scan not refreshing · git
// status not refreshing" for the ~0.6s before the first round completed, which
// is exactly the false alarm that teaches a user to ignore this row.
{
  const startingUp = {
    ...data,
    protocolHealth: undefined,
    collectorHealth: {
      environment: { status: 'pending', lastAttemptAt: new Date(now) },
      git: { status: 'pending', lastAttemptAt: new Date(now) },
    },
  };
  assert.equal(
    renderHealthLine(startingUp, 100, now),
    null,
    'a HUD that is still starting up reports nothing'
  );

  // Once a collector has succeeded and then stopped, it is a real fault again.
  const wentStale = {
    ...startingUp,
    collectorHealth: {
      ...startingUp.collectorHealth,
      git: {
        status: 'stale',
        lastAttemptAt: new Date(now),
        lastSuccessAt: new Date(now - 90_000),
      },
    },
  };
  const staleLine = stripAnsi(renderHealthLine(wentStale, 100, now));
  assert.match(staleLine, /git status 1m old/);
  assert.doesNotMatch(
    staleLine,
    /project scan/,
    'the still-pending collector stays quiet beside it'
  );
}

// A render failure has to reach the pane; the health row is where it lands
// once rendering recovers enough to paint one.
{
  const brokenRenderer = {
    ...data,
    protocolHealth: undefined,
    collectorHealth: {
      renderer: {
        status: 'error',
        lastAttemptAt: new Date(now),
        errorSummary: 'TypeError: bad thing',
      },
    },
  };
  assert.match(
    stripAnsi(renderHealthLine(brokenRenderer, 100, now)),
    /HUD display unavailable/
  );
}

// ---- the build-updated notice --------------------------------------------
// A pane runs the build it was spawned with; after a rebuild this line is
// what says the running HUD and dist/ have diverged, and the fix is one
// command. Absent by default so the row budget is untouched in the steady
// state.
{
  const inlineLayout = { mode: 'expanded', showDuration: true, barWidth: 8 };
  const updated = renderHud(
    { ...data, hudBuildUpdated: true },
    { width: 146, showDetails: true, layout: inlineLayout, maxLines: 12 }
  ).map(stripAnsi);
  assert.ok(
    updated.some((line) =>
      line.includes('HUD updated on disk · codex-hud --reload')
    ),
    'a rebuilt dist is announced on the pane'
  );
  const steady = renderHud(data, {
    width: 146,
    showDetails: true,
    layout: inlineLayout,
    maxLines: 12,
  }).map(stripAnsi);
  assert.ok(
    !steady.some((line) => line.includes('HUD updated on disk')),
    'no notice while the running build matches dist'
  );
}

const overview = renderHud(
  {
    ...data,
    displayMode: 'overview',
    overview: {
      updatedAt: new Date(now),
      sessions: [
        {
          id: data.session.id,
          projectName: '中文项目',
          turnActivity: data.turnActivity,
          lastActivityAt: new Date(now - 8000),
          contextUsage: {
            used: 200000,
            total: 258400,
            percent: 77,
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            compactCount: 0,
          },
        },
      ],
    },
  },
  {
    width: 80,
    showDetails: true,
    layout: {
      mode: 'expanded',
      showDuration: true,
      barWidth: 8,
    },
  }
).map(stripAnsi);
assert.equal(overview.length, 1);
assert.match(overview[0], /中文项目/);
assert.match(overview[0], /Thinking/);
assert.match(overview[0], /23% left/);

console.log('test-display-priority-and-health: PASS');
