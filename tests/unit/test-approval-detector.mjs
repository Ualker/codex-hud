import assert from 'node:assert/strict';

import {
  ApprovalDetector,
  containsApprovalPrompt,
  isApprovalProbeCandidate,
} from '../../dist/collectors/approval-detector.js';

const now = Date.parse('2026-08-14T04:00:00.000Z');
const ago = (ms) => new Date(now - ms);

const stalled = {
  turnActivity: {
    phase: 'running-tool',
    since: ago(60_000),
    lastActivityAt: ago(12_000),
  },
  toolActivity: {
    totalCalls: 1,
    callsByType: { exec_command: 1 },
    lastUpdateTime: ago(12_000),
    recentCalls: [
      {
        id: 'call-1',
        name: 'exec_command',
        status: 'running',
        timestamp: ago(12_000),
      },
    ],
  },
  lastEventAt: ago(12_000),
  approvalPolicy: 'on-request',
};

assert.equal(
  isApprovalProbeCandidate(stalled, now, 5_000),
  true,
  'a silent, suspended running call is eligible for a pane probe'
);
assert.equal(
  isApprovalProbeCandidate(
    { ...stalled, lastEventAt: ago(1000) },
    now,
    5_000
  ),
  false,
  'fresh rollout output is not stalled'
);
assert.equal(
  isApprovalProbeCandidate(
    { ...stalled, approvalPolicy: 'never' },
    now,
    5_000
  ),
  false,
  'an explicitly non-interactive session does not pay for pane capture'
);

const commandApproval = [
  'Would you like to run the following command?',
  '',
  '$ npm test',
  '',
  '> 1. Yes, proceed',
  '  2. No, continue without running it',
  '',
  'Enter to confirm   Esc to cancel',
].join('\n');
assert.equal(containsApprovalPrompt(commandApproval), true);
assert.equal(
  containsApprovalPrompt('Would you like to run the following command?'),
  false,
  'a phrase in transcript text is not enough without interactive controls'
);
assert.equal(
  containsApprovalPrompt(
    'Approval needed in Birch [reviewer]\n    /agent to switch threads'
  ),
  true,
  'pending subagent approvals use their own paired UI marker'
);
assert.equal(
  containsApprovalPrompt(
    'Do you want to approve network access to "example.com"?\n' +
      '> Yes, just this once\n  No, and block this host in the future'
  ),
  true
);

let captures = 0;
let paneText = commandApproval;
const detector = new ApprovalDetector({
  mainPane: '%7',
  stallMs: 5_000,
  probeIntervalMs: 10_000,
  capturePane: async (pane) => {
    captures++;
    assert.equal(pane, '%7');
    return paneText;
  },
});

assert.equal(await detector.refresh(stalled, now), true, 'first match changes state');
assert.equal(detector.isApprovalNeeded(), true);
assert.equal(captures, 1);

assert.equal(
  await detector.refresh(stalled, now + 1000),
  false,
  'the low-frequency gate does not report another change'
);
assert.equal(captures, 1, 'and does not capture again inside the interval');

paneText = 'ordinary Codex transcript';
assert.equal(await detector.refresh(stalled, now + 10_000), true);
assert.equal(detector.isApprovalNeeded(), false, 'a current non-prompt pane clears the state');
assert.equal(captures, 2);

await detector.refresh(stalled, now + 20_000);
assert.equal(detector.isApprovalNeeded(), false);
assert.equal(captures, 3);
assert.equal(
  await detector.refresh(
    {
      ...stalled,
      turnActivity: { ...stalled.turnActivity, phase: 'thinking' },
    },
    now + 20_001
  ),
  false,
  'leaving the structural candidate remains cleared without a pane probe'
);
assert.equal(captures, 3);

let resolveCapture;
const delayedDetector = new ApprovalDetector({
  mainPane: '%8',
  stallMs: 5_000,
  probeIntervalMs: 10_000,
  capturePane: () =>
    new Promise((resolve) => {
      resolveCapture = resolve;
    }),
});
const delayedRefresh = delayedDetector.refresh(stalled, now);
delayedDetector.reset();
resolveCapture(commandApproval);
assert.equal(
  await delayedRefresh,
  false,
  'an in-flight capture from a reset session cannot change the new session'
);
assert.equal(delayedDetector.isApprovalNeeded(), false);

let resolveResolvedCallCapture;
const resolvedCallDetector = new ApprovalDetector({
  mainPane: '%9',
  stallMs: 5_000,
  probeIntervalMs: 10_000,
  capturePane: () =>
    new Promise((resolve) => {
      resolveResolvedCallCapture = resolve;
    }),
});
const resolvedCallRefresh = resolvedCallDetector.refresh(stalled, now);
await resolvedCallDetector.refresh(
  {
    ...stalled,
    turnActivity: { ...stalled.turnActivity, phase: 'idle' },
  },
  now + 1
);
resolveResolvedCallCapture(commandApproval);
assert.equal(
  await resolvedCallRefresh,
  false,
  'a tool completion invalidates a pane capture that was already running'
);
assert.equal(resolvedCallDetector.isApprovalNeeded(), false);

console.log('test-approval-detector: PASS');
