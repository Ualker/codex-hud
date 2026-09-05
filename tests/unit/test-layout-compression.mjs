import assert from 'node:assert/strict';

import { renderHud } from '../../dist/render/header.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';

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

function makeData({ agentCount = 0, bound = true } = {}) {
  const data = {
    config: {
      model: 'gpt-5.6-sol',
      sandbox_mode: 'danger-full-access',
      approval_policy: 'never',
    },
    git: {
      isGitRepo: true,
      branch: 'integrate/upstream-main-20260714',
      isDirty: true,
      ahead: 2,
      behind: 0,
      modified: 3,
      added: 1,
      deleted: 0,
      untracked: 2,
    },
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
    sessionStart: ago(3 * 3600_000),
    collectorHealth: {},
    displayMode: 'single',
    tokenUsage: {
      model_context_window: 258400,
      last_token_usage: {
        input_tokens: 138495,
        cached_input_tokens: 132864,
        output_tokens: 16445,
        total_tokens: 154940,
      },
      total_token_usage: { total_tokens: 2704295 },
    },
    contextUsage: {
      used: 154940,
      total: 258400,
      percent: 60,
      inputTokens: 5631,
      outputTokens: 16445,
      cachedTokens: 132864,
      compactCount: 2,
    },
    turnActivity: {
      phase: 'running-tool',
      since: ago(12_000),
      lastActivityAt: ago(2_000),
      turnId: 'turn-9',
    },
    toolActivity: {
      totalCalls: 41,
      callsByType: {},
      lastUpdateTime: ago(2_000),
      recentCalls: [
        {
          id: 'running',
          name: 'exec_command',
          status: 'running',
          timestamp: ago(12_000),
          target: 'rg -n pattern src',
        },
      ],
    },
    planProgress: {
      totalSteps: 7,
      completedSteps: 3,
      steps: [
        { step: 'inspect renderer', status: 'completed' },
        { step: 'wire cadence into the main loop', status: 'in_progress' },
      ],
    },
    agentActivity: {
      visibleAgentCount: agentCount,
      rootTrackingError: false,
      rows: Array.from({ length: agentCount }, (_, index) => ({
        label: `agent-${index}`,
        status: 'running',
        elapsedStartedAt: ago(30_000 + index * 1000),
        activeDescendantCount: index === 0 ? 1 : 0,
      })),
    },
  };

  if (!bound) {
    // Every one of these is derived from the bound rollout, so an unbound HUD
    // never has them; keeping them would test a state that cannot occur.
    delete data.session;
    delete data.turnActivity;
    delete data.toolActivity;
    delete data.planProgress;
    delete data.tokenUsage;
    delete data.contextUsage;
    delete data.agentActivity;
    return data;
  }

  {
    data.session = {
      id: '019fd67f-1111-2222-3333-4444444445b93',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'max',
      cwd: '/Users/zyb/Desktop/prj',
      cliVersion: '0.147.0',
      modelProvider: 'openai',
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      startTime: ago(3 * 3600_000),
    };
  }
  return data;
}

const render = (data, maxLines) =>
  renderHud(data, { width: WIDTH, showDetails: true, layout, maxLines }).map(
    stripAnsi
  );

// The live panes run seven rows. Plain truncation used to keep a static config
// row while dropping the plan row and even a running agent — hiding the most
// work exactly when the most work was happening.
const HEIGHT = 7;

for (const agentCount of [0, 1, 2, 3, 4, 6]) {
  const lines = render(makeData({ agentCount }), HEIGHT);
  assert.ok(
    lines.length <= HEIGHT,
    `${agentCount} agents must compress into ${HEIGHT} rows, got ${lines.length}`
  );
  for (const line of lines) {
    assert.ok(
      visualLength(line) <= WIDTH,
      `every compressed row stays within the pane width: ${line}`
    );
  }
}

// Two or more agents collapse into one counted row rather than pushing the
// plan row off the bottom.
const collapsed = render(makeData({ agentCount: 4 }), HEIGHT);
assert.ok(
  collapsed.some((line) => /\b4 agents\b/.test(line)),
  'collapsed agents keep their count visible'
);
assert.ok(
  collapsed.some((line) => line.includes('3/7')),
  'the plan row survives a crowded frame'
);
assert.ok(
  collapsed.some((line) => line.includes('↳1')),
  'descendant counts survive the collapse'
);

// A single agent is never collapsed: its own row already fits and carries a
// label the count would discard.
const single = render(makeData({ agentCount: 1 }), HEIGHT);
assert.ok(
  single.some((line) => line.includes('agent-0')),
  'one agent keeps its label'
);
assert.ok(
  !single.some((line) => /\b1 agents\b/.test(line)),
  'one agent is never rendered as a count'
);

// The sandbox badge moves up to row 1 rather than vanishing with the
// environment row.
const crowded = render(makeData({ agentCount: 6 }), HEIGHT);
assert.ok(
  crowded.some((line) => line.includes('[FULL ACCESS]')),
  'the sandbox badge survives even when its row does not'
);

// Rows are handed back by value until the frame is full: two agents leave a
// row for the turn row, and nothing sits blank while there is state to show.
{
  const two = render(makeData({ agentCount: 2 }), HEIGHT);
  assert.equal(two.length, HEIGHT, 'the frame is filled');
  assert.ok(two.some((line) => line.includes('Running tool')), 'the turn row is added back');
  assert.ok(two.some((line) => line.includes('agent-1')), 'both agents stay expanded');
  const three = render(makeData({ agentCount: 3 }), HEIGHT);
  assert.equal(three.length, HEIGHT, 'three agents also fill the frame');
  assert.ok(three.some((line) => line.includes('agent-2')));
}

// An unbound HUD says so rather than rendering a short frame that reads as
// broken.
const unbound = render(makeData({ bound: false }), HEIGHT);
assert.ok(
  unbound.some((line) => line.includes('Waiting for a Codex session')),
  'an unbound HUD states what it is waiting for'
);

// Codex creates a rollout lazily, on the first turn, so a session can be bound
// and identified while nothing has been written for the HUD to read — measured
// on a session sitting at the prompt for 19 hours with no rollout on disk.
// That is a different sentence from "no session at all".
const boundNoTurns = makeData();
delete boundNoTurns.turnActivity;
delete boundNoTurns.toolActivity;
delete boundNoTurns.planProgress;
delete boundNoTurns.tokenUsage;
delete boundNoTurns.contextUsage;
delete boundNoTurns.agentActivity;
const idleFrame = render(boundNoTurns, HEIGHT);
assert.ok(
  idleFrame.some((line) => line.includes('Session ready · no turns yet')),
  'a bound session with no rollout yet is distinguished from an unbound one'
);
assert.ok(
  !idleFrame.some((line) => line.includes('Waiting for a Codex session')),
  'the two states do not share a message'
);

// Without a row budget nothing is compressed away.
const uncompressed = render(makeData({ agentCount: 4 }), Number.POSITIVE_INFINITY);
assert.ok(
  uncompressed.some((line) => line.includes('agent-3')),
  'an unbounded viewport shows every agent row'
);
assert.ok(
  uncompressed.some((line) => line.startsWith('Dir: ')),
  'an unbounded viewport keeps the session detail row'
);

// Cumulative spend is rendered; it was parsed all along but never displayed.
assert.ok(
  uncompressed.some((line) => line.includes('Total: 2.7M')),
  'session-total tokens reach the screen'
);

console.log('test-layout-compression: PASS');
