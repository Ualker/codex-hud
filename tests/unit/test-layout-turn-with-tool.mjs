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

/**
 * A turn that has been executing tools for four minutes, with a command that
 * started twelve seconds ago. Those are the two numbers the layout has to keep
 * apart: `turnActivity.since` is the phase start, so it counts the whole run of
 * tools, while the tool row counts only the call in flight.
 */
function makeData({ agentCount = 0, planSteps = 0 } = {}) {
  return {
    config: {
      model: 'gpt-5.6-sol',
      sandbox_mode: 'workspace-write',
      approval_policy: 'on-request',
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
    sessionStart: ago(3 * 3600_000),
    collectorHealth: {},
    displayMode: 'single',
    tokenUsage: {
      model_context_window: 258400,
      last_token_usage: { total_tokens: 154940 },
      total_token_usage: { total_tokens: 2704295 },
    },
    contextUsage: {
      used: 154940,
      total: 258400,
      percent: 60,
      inputTokens: 5631,
      outputTokens: 16445,
      cachedTokens: 132864,
      compactCount: 0,
    },
    turnActivity: {
      phase: 'running-tool',
      since: ago(240_000),
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
    ...(planSteps > 0
      ? {
          planProgress: {
            totalSteps: planSteps,
            completedSteps: 1,
            steps: [{ step: 'inspect renderer', status: 'in_progress' }],
          },
        }
      : {}),
    agentActivity: {
      visibleAgentCount: agentCount,
      rootTrackingError: false,
      rows: Array.from({ length: agentCount }, (_, index) => ({
        label: `agent-${index}`,
        status: 'running',
        elapsedStartedAt: ago(30_000 + index * 1000),
        activeDescendantCount: 0,
      })),
    },
    session: {
      id: '019fd67f-1111-2222-3333-444444445b93',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'max',
      cwd: '/Users/zyb/Desktop/prj',
      cliVersion: '0.147.0',
      modelProvider: 'openai',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      startTime: ago(3 * 3600_000),
    },
  };
}

const render = (data, maxLines) =>
  renderHud(data, { width: WIDTH, showDetails: true, layout, maxLines }).map(
    stripAnsi
  );

// The running-tool row used to replace the turn row at every height, including
// heights with rows to spare: a seven-row pane rendered five rows and still
// hid how long the turn had been going.
{
  const lines = render(makeData(), Number.POSITIVE_INFINITY);
  const turnRow = lines.find((line) => line.includes('Running tool'));
  const toolRow = lines.find((line) => line.includes('exec_command'));

  assert.ok(turnRow, 'an unclipped layout states how long the turn has run');
  assert.ok(toolRow, 'and still lists the call in flight');
  assert.match(
    turnRow,
    /Running tool 4m/,
    'the turn row counts the phase, not the current call'
  );
  assert.match(
    toolRow,
    /12s/,
    'the tool row counts the current call, not the phase'
  );
  assert.ok(
    lines.indexOf(turnRow) < lines.indexOf(toolRow),
    'turn state leads the detail it summarizes'
  );
}

// The same holds at the real pane geometry, which has the room for it.
{
  const lines = render(makeData(), 7);
  assert.ok(lines.length <= 7);
  assert.ok(
    lines.some((line) => line.includes('Running tool 4m')),
    'seven rows are enough to keep the turn row'
  );
  assert.ok(
    lines.some((line) => line.includes('exec_command')),
    'and the tool row with it'
  );
}

// When the rows genuinely run out, the added row is the first to go again —
// live agent and plan rows outrank it.
{
  const lines = render(makeData({ agentCount: 2, planSteps: 7 }), 7);
  assert.ok(lines.length <= 7, `must fit seven rows, got ${lines.length}`);
  assert.equal(
    lines.some((line) => line.includes('Running tool')),
    false,
    'the promoted row yields before agent and plan rows do'
  );
  assert.ok(
    lines.some((line) => line.includes('agent-1')),
    'both running agents survive'
  );
  assert.ok(
    lines.some((line) => line.includes('exec_command')),
    'the call in flight survives'
  );
}

// Nothing changes when no tool is running: the turn row was never displaced.
{
  const data = makeData();
  data.turnActivity = {
    phase: 'thinking',
    since: ago(4_000),
    lastActivityAt: ago(1_000),
    turnId: 'turn-9',
  };
  data.toolActivity.recentCalls[0].status = 'completed';
  const lines = render(data, 7);
  assert.equal(
    lines.filter((line) => line.includes('Thinking')).length,
    1,
    'the turn row is not duplicated'
  );
}

// Approval is the actionable state of an otherwise open tool call. It keeps
// the turn row when space is tight, and neither that row nor the optional tool
// detail pretends the call is advancing with an animated spinner.
{
  const data = makeData({ agentCount: 2, planSteps: 7 });
  data.turnActivity = {
    ...data.turnActivity,
    phase: 'awaiting-approval',
  };
  const lines = render(data, 7);
  assert.ok(
    lines.some((line) => line.includes('Approval needed')),
    'approval survives the same crowded frame that drops ordinary turn detail'
  );
  assert.equal(
    lines.some((line) => line.includes('Running tool')),
    false
  );
  const tool = lines.find((line) => line.includes('exec_command'));
  if (tool) {
    assert.match(tool, /⏸/, 'a visible suspended tool uses the fixed pause icon');
    assert.doesNotMatch(tool, /[◐◓◑◒]/, 'no spinner frame remains');
  }
}

console.log('test-layout-turn-with-tool: PASS');
