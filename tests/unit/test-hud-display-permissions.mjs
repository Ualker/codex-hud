import assert from 'node:assert/strict';

import {
  getApprovalPolicyDisplay,
  getFastModeDisplay,
} from '../../dist/collectors/codex-config.js';
import { stripAnsi } from '../../dist/render/colors.js';
import { renderHud } from '../../dist/render/header.js';
import { renderTokenLine } from '../../dist/render/lines/activity-line.js';

const layout = {
  mode: 'expanded',
  showSeparators: false,
  showDuration: true,
  showContextBreakdown: true,
  barWidth: 10,
};

const baseData = {
  config: {
    model: 'gpt-5.6-sol',
    model_reasoning_effort: 'high',
    model_provider: 'stepcode',
  },
  git: {
    branch: 'main',
    isDirty: true,
    isGitRepo: true,
    ahead: 0,
    behind: 0,
    modified: 1,
    added: 0,
    deleted: 0,
    untracked: 0,
  },
  project: {
    cwd: '/tmp/new-topic-research',
    projectName: 'new-topic-research',
    agentsMdCount: 0,
    hasCodexDir: false,
    instructionsMdCount: 0,
    rulesCount: 0,
    mcpCount: 2,
    configsCount: 0,
    extensionsCount: 2,
    skillsCount: 3,
    hooksCount: 2,
    workMode: 'development',
  },
  sessionStart: new Date('2026-07-27T00:00:00Z'),
  session: {
    id: '019f9db5-0000-7000-8000-000000000000',
    rolloutPath: '/tmp/rollout.jsonl',
    startTime: new Date('2026-07-27T00:00:00Z'),
    cwd: '/tmp/new-topic-research',
    cliVersion: '0.144.4',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
    serviceTier: 'priority',
  },
  tokenUsage: {
    last_token_usage: {
      total_tokens: 282400,
      input_tokens: 282142,
      cached_input_tokens: 281300,
      output_tokens: 199,
    },
    model_context_window: 341400,
  },
  contextUsage: {
    used: 270400,
    total: 341400,
    percent: 79,
    inputTokens: 842,
    outputTokens: 199,
    cachedTokens: 281300,
    compactCount: 8,
  },
  displayMode: 'single',
};

const tokenLine = stripAnsi(renderTokenLine(baseData));
assert.match(tokenLine, /^Ctx: /, 'context segment must lead the token row');
assert.ok(tokenLine.indexOf('Ctx: ') < tokenLine.indexOf('Tokens: '), 'Tokens must follow Ctx');
assert.match(tokenLine, /Ctx: .*21% left \(71\.0K\) \| Tokens: 282\.4K/);
assert.match(
  tokenLine,
  /Tokens: 282\.4K \| \(in: 842, cache: 281\.3K, out: 199\) \| ↻8$/
);

const expandedLines = renderHud(baseData, {
  width: 160,
  showDetails: true,
  layout,
}).map(stripAnsi);
const environmentLine = expandedLines.find((line) => line.includes('Approval:'));
assert.ok(environmentLine, 'expanded layout must render an environment line');
assert.doesNotMatch(environmentLine, /mode:/, 'environment line must not expose mode');
assert.match(environmentLine, /Approval: ask for approval/);
assert.match(environmentLine, /Fast: on/);
assert.match(environmentLine, /MCP configured: 2.*Codex skills: 3.*Hooks: 2/);

const runtimePermissionLines = renderHud({
  ...baseData,
  session: {
    ...baseData.session,
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
  },
}, {
  width: 160,
  showDetails: true,
  layout,
}).map(stripAnsi);
const runtimeEnvironmentLine = runtimePermissionLines.find((line) =>
  line.startsWith('[FULL ACCESS]')
);
assert.ok(runtimeEnvironmentLine, 'full-access badge line must render');
assert.doesNotMatch(
  runtimeEnvironmentLine,
  /Approval: |Sandbox: /,
  'cells implied by the badge are dropped'
);
assert.match(runtimeEnvironmentLine, /MCP configured: 2/);

const recoveredPartialLines = renderHud({
  ...baseData,
  partialHistory: true,
  session: {
    ...baseData.session,
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
  },
}, {
  width: 160,
  showDetails: true,
  layout,
}).map(stripAnsi);
assert.ok(
  recoveredPartialLines.some((line) => line.startsWith('[FULL ACCESS]')),
  'recovered runtime state stays authoritative even when counters are partial'
);

const unknownPartialSession = { ...baseData.session };
delete unknownPartialSession.model;
delete unknownPartialSession.reasoningEffort;
delete unknownPartialSession.approvalPolicy;
delete unknownPartialSession.sandboxMode;
delete unknownPartialSession.serviceTier;
const unknownPartialLines = renderHud({
  ...baseData,
  partialHistory: true,
  session: unknownPartialSession,
}, {
  width: 160,
  showDetails: true,
  layout,
}).map(stripAnsi);
assert.match(
  unknownPartialLines[0],
  /^\[\?\]/,
  'a partial rollout must not present the current config model as session fact'
);
const unknownEnvironmentLine = unknownPartialLines.find((line) =>
  line.includes('Approval:')
);
assert.ok(unknownEnvironmentLine);
assert.match(unknownEnvironmentLine, /Approval: \?/);
assert.match(unknownEnvironmentLine, /Sandbox: \?/);
assert.match(unknownEnvironmentLine, /Fast: \?/);
assert.doesNotMatch(
  unknownEnvironmentLine,
  /ask for approval|workspace-write/,
  'partial-history fallbacks carry an uncertainty marker instead of config values'
);
const compressedUnknownLines = renderHud({
  ...baseData,
  partialHistory: true,
  session: unknownPartialSession,
}, {
  width: 160,
  showDetails: true,
  layout,
  maxLines: 1,
}).map(stripAnsi);
assert.match(
  compressedUnknownLines[0],
  /\[ACCESS \?\]/,
  'dropping the environment row moves an unknown-access badge to row one'
);
assert.doesNotMatch(compressedUnknownLines[0], /\[FULL ACCESS\]/);

// ---- the no-rollout world (codex 0.149) -----------------------------------
// A bound session can sit for hours with no rollout written; the launch flags
// then outrank the config file they override. Measured live: a `--yolo` pane
// whose HUD read `Approval: ask for approval | Sandbox: workspace-write` off
// config — the opposite of what the process would do.

const flaggedConfig = {
  ...baseData.config,
  approval_policy: 'on-request',
  sandbox_mode: 'workspace-write',
};
const metadataOnlySession = {
  id: '01a03266-f1aa-7b90-b15e-96a8d7d0a897',
  startTime: new Date('2026-08-24T06:13:22Z'),
  cwd: '/tmp/new-topic-research',
};

const yoloNoRolloutLines = renderHud({
  ...baseData,
  config: flaggedConfig,
  session: metadataOnlySession,
  boundWithoutRollout: true,
  paneCliPolicy: { approvalPolicy: 'never', sandboxMode: 'danger-full-access' },
}, {
  width: 160,
  showDetails: true,
  layout,
}).map(stripAnsi);
assert.ok(
  yoloNoRolloutLines.some((line) => line.startsWith('[FULL ACCESS]')),
  'launch flags are the truth while the session has no records'
);
assert.ok(
  !yoloNoRolloutLines.some((line) => /ask for approval|workspace-write/.test(line)),
  'the config the flags override must not be presented as session fact'
);

const blindNoRolloutLines = renderHud({
  ...baseData,
  config: flaggedConfig,
  session: metadataOnlySession,
  boundWithoutRollout: true,
}, {
  width: 160,
  showDetails: true,
  layout,
}).map(stripAnsi);
const blindEnvironmentLine = blindNoRolloutLines.find((line) =>
  line.includes('Approval:')
);
assert.ok(blindEnvironmentLine);
assert.match(blindEnvironmentLine, /Approval: \?/);
assert.match(blindEnvironmentLine, /Sandbox: \?/);
assert.doesNotMatch(
  blindEnvironmentLine,
  /ask for approval|workspace-write/,
  'no records and no readable flags is unknown, never config'
);
const blindCompressed = renderHud({
  ...baseData,
  config: flaggedConfig,
  session: metadataOnlySession,
  boundWithoutRollout: true,
}, {
  width: 160,
  showDetails: true,
  layout,
  maxLines: 1,
}).map(stripAnsi);
assert.match(blindCompressed[0], /\[ACCESS \?\]/);

// A captured argv walked to its end with no policy flag and no profile
// certifies the config un-overridden: a plain `codex-hud` launch no longer
// sits on `?` until its first message.
const certifiedNoRolloutLines = renderHud({
  ...baseData,
  config: flaggedConfig,
  session: metadataOnlySession,
  boundWithoutRollout: true,
  paneCliPolicy: { exhaustive: true },
}, {
  width: 160,
  showDetails: true,
  layout,
}).map(stripAnsi);
const certifiedEnvironmentLine = certifiedNoRolloutLines.find((line) =>
  line.includes('Approval:')
);
assert.ok(certifiedEnvironmentLine);
assert.match(certifiedEnvironmentLine, /Approval: ask for approval/);
assert.match(certifiedEnvironmentLine, /Sandbox: workspace-write/);
assert.ok(
  !certifiedNoRolloutLines.some((line) => /\[ACCESS \?\]/.test(line)),
  'a certified argv lifts the unknown-access badge'
);

// Codex's own exit reopens the config fallback: nothing is running for the
// flags to describe.
const exitedNoRolloutLines = renderHud({
  ...baseData,
  config: flaggedConfig,
  session: metadataOnlySession,
  boundWithoutRollout: true,
  codexExited: true,
}, {
  width: 160,
  showDetails: true,
  layout,
}).map(stripAnsi);
const exitedEnvironmentLine = exitedNoRolloutLines.find((line) =>
  line.includes('Approval:')
);
assert.ok(exitedEnvironmentLine);
assert.match(exitedEnvironmentLine, /Approval: ask for approval/);
assert.match(exitedEnvironmentLine, /Sandbox: workspace-write/);

// A fresh session at the prompt runs the flags; the bound records describe
// the previous session there. Without the fresh mark, records still win.
const freshPaneLines = renderHud({
  ...baseData,
  config: flaggedConfig,
  paneFreshSession: true,
  paneCliPolicy: { approvalPolicy: 'never', sandboxMode: 'danger-full-access' },
}, {
  width: 160,
  showDetails: true,
  layout,
}).map(stripAnsi);
assert.ok(
  freshPaneLines.some((line) => line.startsWith('[FULL ACCESS]')),
  'the fresh prompt runs the launch flags, not the previous session\'s policy'
);
const samePaneLines = renderHud({
  ...baseData,
  config: flaggedConfig,
  paneCliPolicy: { approvalPolicy: 'never', sandboxMode: 'danger-full-access' },
}, {
  width: 160,
  showDetails: true,
  layout,
}).map(stripAnsi);
const samePaneEnvironment = samePaneLines.find((line) =>
  line.includes('Approval:')
);
assert.ok(samePaneEnvironment);
assert.match(
  samePaneEnvironment,
  /Approval: ask for approval/,
  'a bound session with records follows its own records, not the launch flags'
);
assert.match(samePaneEnvironment, /Sandbox: workspace-write/);

const unknownEffortSession = {
  ...baseData.session,
  model: 'gpt-5.6-session',
};
delete unknownEffortSession.reasoningEffort;
const unknownEffortLines = renderHud({
  ...baseData,
  partialHistory: true,
  session: unknownEffortSession,
}, {
  width: 160,
  showDetails: true,
  layout,
}).map(stripAnsi);
assert.match(
  unknownEffortLines[0],
  /^\[gpt-5\.6-session \?\]/,
  'a recovered model does not borrow a missing reasoning effort from config'
);

assert.equal(getApprovalPolicyDisplay({ approval_policy: 'on-request' }), 'ask for approval');
assert.equal(getApprovalPolicyDisplay({ approval_policy: 'untrusted' }), 'ask for approval');
assert.equal(getApprovalPolicyDisplay({ approval_policy: 'on-failure' }), 'approve for me');
assert.equal(
  getApprovalPolicyDisplay({ approval_policy: 'never', sandbox_mode: 'workspace-write' }),
  'approve for me'
);
assert.equal(
  getApprovalPolicyDisplay({ approval_policy: 'never', sandbox_mode: 'danger-full-access' }),
  'full access'
);
assert.equal(
  getApprovalPolicyDisplay(
    { approval_policy: 'on-request', sandbox_mode: 'workspace-write' },
    { approvalPolicy: 'never', sandboxMode: 'danger-full-access' }
  ),
  'full access',
  'runtime permission must override config permission'
);

assert.equal(getFastModeDisplay({ service_tier: 'fast' }), 'Fast: on');
assert.equal(getFastModeDisplay({ service_tier: 'default' }), 'Fast: off');
assert.equal(
  getFastModeDisplay({ service_tier: 'default' }, { serviceTier: 'priority' }),
  'Fast: on'
);
assert.equal(
  getFastModeDisplay({ service_tier: 'fast' }, { serviceTier: 'default' }),
  'Fast: off'
);
assert.equal(
  getFastModeDisplay({ service_tier: 'fast' }, { serviceTier: null }),
  'Fast: off',
  'a null runtime tier must remain the default tier'
);

console.log('test-hud-display-permissions: PASS');
