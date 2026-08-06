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

const rate = stripAnsi(renderRateLimitLine(data, 80));
assert.match(rate, /5h limit 82%/);
assert.match(rate, /7d limit 91%/);
assert.match(rate, /resets/);

const health = stripAnsi(renderHealthLine(data, 100, now));
assert.match(health, /git stale 18s/);
assert.match(health, /rollout error/);
assert.match(health, /protocol unknown 1/);
assert.doesNotMatch(health, /private details/);

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
