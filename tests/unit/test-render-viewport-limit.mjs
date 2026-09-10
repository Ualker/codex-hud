import assert from 'node:assert/strict';

import { fitLinesToViewport } from '../../dist/render/index.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { renderHud } from '../../dist/render/header.js';
import { renderSessionDetailLine } from '../../dist/render/lines/activity-line.js';

const lines = [
  'identity',
  'security',
  'context',
  'thinking',
  'agent status with a deliberately long descriptive label',
  'plan',
  'session',
];

const fitted = fitLinesToViewport(lines, 5, 32);
assert.equal(fitted.length, 5);
assert.match(stripAnsi(fitted[4]), /\+2 hidden$/);
assert.match(stripAnsi(fitted[4]), /^agent status/);
for (const line of fitted) {
  assert.ok(visualLength(line) <= 32);
}

const now = new Date('2026-07-30T13:00:00.000Z');
const hudData = {
  config: {
    model: 'gpt-5.6-sol',
    approval_policy: 'never',
    sandbox_mode: 'workspace-write',
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
    cwd: '/srv/workspaces/organization/platform/services/codex-hud',
    projectName: 'codex-hud',
    agentsMdCount: 0,
    hasCodexDir: true,
    instructionsMdCount: 0,
    rulesCount: 0,
    mcpCount: 0,
    configsCount: 0,
    extensionsCount: 0,
    skillsCount: 0,
    hooksCount: 0,
    globalConfigActive: false,
    workMode: 'development',
  },
  sessionStart: new Date(now.getTime() - 60_000),
  session: {
    id: '019b1111-a111-7111-8111-111111111111',
    cwd: '/srv/workspaces/organization/platform/services/codex-hud',
    startTime: new Date(now.getTime() - 60_000),
    cliVersion: '0.146.0',
  },
  contextUsage: {
    used: 50_000,
    total: 200_000,
    percent: 25,
    inputTokens: 30_000,
    outputTokens: 10_000,
    cachedTokens: 10_000,
    compactCount: 0,
  },
  turnActivity: {
    phase: 'idle',
    since: now,
    lastActivityAt: now,
  },
  toolActivity: {
    recentCalls: [
      {
        id: 'call-1',
        name: 'read_file',
        timestamp: now,
        status: 'completed',
        target: 'src/render/header.ts',
      },
    ],
    totalCalls: 1,
    callsByType: { read_file: 1 },
    lastUpdateTime: now,
  },
  displayMode: 'single',
};

// Full details deliberately adds history and identity, exercising clipping.
process.env.CODEX_HUD_DETAILS = 'full';
const expanded = renderHud(hudData, {
  width: 90,
  showDetails: true,
  layout: {
    mode: 'expanded',
    showDuration: true,
    showContextBreakdown: true,
    barWidth: 10,
  },
});
const responsiveViewport = fitLinesToViewport(expanded, 5, 90).map(stripAnsi);
assert.equal(expanded.length, 6);
// Live tool history outranks the static Dir/Session line: a small pane hides
// the identity line first.
assert.match(responsiveViewport[4], /read_file/);
assert.match(responsiveViewport[4], /\+1 hidden$/);
assert.doesNotMatch(responsiveViewport.join('\n'), /Dir:/);

const narrowSession = renderSessionDetailLine(hudData, 36);
assert.ok(narrowSession);
assert.ok(visualLength(narrowSession) <= 36);
assert.match(stripAnsi(narrowSession), /^Dir: …/);
assert.match(stripAnsi(narrowSession), /codex-hud$/);

console.log('test-render-viewport-limit: PASS');
