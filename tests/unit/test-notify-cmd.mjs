import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HudNotifier } from '../../dist/notify.js';

const now = Date.parse('2026-08-20T12:00:00.000Z');
const context = {
  sessionId: '01a01d4f-41a9-76e1-bff2-984911a0d958',
  tmuxSession: 'codex-hud-prj-2a51592d-20260820115523-29120',
  cwd: '/Users/zyb/Desktop/prj',
};

const quiet = {
  'approval-needed': false,
  'turn-interrupted': false,
  'limit-reached': false,
};

function recorder() {
  const calls = [];
  return {
    calls,
    run: async (command, payload) => {
      calls.push({ command, payload: JSON.parse(payload) });
    },
  };
}

{
  // The first observation seeds the baseline silently: a HUD launched in
  // front of a session already waiting for approval must not page the user
  // about the screen they are looking at.
  const { calls, run } = recorder();
  const notifier = new HudNotifier({ command: 'notify', runCommand: run });
  assert.deepEqual(
    notifier.observe({ ...quiet, 'approval-needed': true }, context, now),
    [],
    'a pre-existing state is a baseline, not a transition'
  );
  assert.equal(calls.length, 0);

  // Clearing and tripping again is a transition and fires.
  notifier.observe(quiet, context, now + 1000);
  const fired = notifier.observe(
    { ...quiet, 'approval-needed': true },
    context,
    now + 2000
  );
  assert.deepEqual(fired, ['approval-needed']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'notify');
  assert.deepEqual(calls[0].payload, {
    event: 'approval-needed',
    sessionId: context.sessionId,
    tmuxSession: context.tmuxSession,
    cwd: context.cwd,
    at: new Date(now + 2000).toISOString(),
  });

  // A sustained state is one event, not one per render tick.
  notifier.observe({ ...quiet, 'approval-needed': true }, context, now + 3000);
  assert.equal(calls.length, 1, 'no refire while the state holds');

  // Flapping inside the cooldown stays silent; past it, a new edge fires.
  notifier.observe(quiet, context, now + 4000);
  notifier.observe({ ...quiet, 'approval-needed': true }, context, now + 5000);
  assert.equal(calls.length, 1, 'a flap within the cooldown is absorbed');
  notifier.observe(quiet, context, now + 6 * 60_000);
  notifier.observe(
    { ...quiet, 'approval-needed': true },
    context,
    now + 7 * 60_000
  );
  assert.equal(calls.length, 2, 'a fresh edge past the cooldown fires again');
}

{
  // Rebinding hands the detectors a different session; the switch itself must
  // not read as a transition.
  const { calls, run } = recorder();
  const notifier = new HudNotifier({ command: 'notify', runCommand: run });
  notifier.observe(quiet, context, now);
  notifier.reset();
  notifier.observe({ ...quiet, 'turn-interrupted': true }, context, now + 1000);
  assert.equal(calls.length, 0, 'the first post-rebind observation reseeds');
  notifier.observe(quiet, context, now + 2000);
  const fired = notifier.observe(
    { ...quiet, 'turn-interrupted': true },
    context,
    now + 3000
  );
  assert.deepEqual(fired, ['turn-interrupted']);
}

{
  // Unconfigured means inert: no command, no calls, no errors.
  const { calls, run } = recorder();
  const notifier = new HudNotifier({ command: undefined, runCommand: run });
  notifier.observe(quiet, context, now);
  notifier.observe({ ...quiet, 'limit-reached': true }, context, now + 1000);
  assert.equal(calls.length, 0);
}

{
  // Two states tripping in one observation are two events.
  const { calls, run } = recorder();
  const notifier = new HudNotifier({ command: 'notify', runCommand: run });
  notifier.observe(quiet, context, now);
  const fired = notifier.observe(
    { ...quiet, 'approval-needed': true, 'limit-reached': true },
    context,
    now + 1000
  );
  assert.deepEqual(fired, ['approval-needed', 'limit-reached']);
  assert.equal(calls.length, 2);
}

{
  // A failing command is logged, never thrown into the render loop.
  const notifier = new HudNotifier({
    command: 'notify',
    runCommand: async () => {
      throw new Error('spawn failed');
    },
  });
  notifier.observe(quiet, context, now);
  assert.doesNotThrow(() =>
    notifier.observe({ ...quiet, 'approval-needed': true }, context, now + 1000)
  );
}

// ---- the real shell path ---------------------------------------------------
// The default runner feeds the JSON on stdin and in the environment; prove
// both with an actual /bin/sh command.
{
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-notify-'));
  const outFile = path.join(tempDir, 'event.json');
  try {
    const notifier = new HudNotifier({
      command: `cat > ${outFile}; printf '%s' "$CODEX_HUD_EVENT" > ${outFile}.name`,
    });
    notifier.observe(quiet, context, now);
    notifier.observe({ ...quiet, 'limit-reached': true }, context, now + 1000);
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(`${outFile}.name`) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const stdinPayload = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.equal(stdinPayload.event, 'limit-reached');
    assert.equal(stdinPayload.cwd, context.cwd);
    assert.equal(
      fs.readFileSync(`${outFile}.name`, 'utf8'),
      'limit-reached',
      'the bare event name rides in CODEX_HUD_EVENT'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

console.log('test-notify-cmd: PASS');
