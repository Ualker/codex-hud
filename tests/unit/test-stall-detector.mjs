import assert from 'node:assert/strict';

import {
  StallDetector,
  containsStreamErrorBanner,
  isStallProbeCandidate,
} from '../../dist/collectors/stall-detector.js';

const now = Date.parse('2026-08-19T04:00:00.000Z');
const ago = (ms) => new Date(now - ms);
const SILENCE = 5 * 60_000;

// ---- candidacy -----------------------------------------------------------

const silentThinking = {
  turnActivity: {
    phase: 'thinking',
    since: ago(11 * 60_000),
    lastActivityAt: ago(9 * 60_000),
  },
  lastEventAt: ago(9 * 60_000),
};

assert.equal(
  isStallProbeCandidate(silentThinking, now, SILENCE),
  true,
  'a turn that has been thinking silently for minutes is worth one capture'
);
assert.equal(
  isStallProbeCandidate(
    { ...silentThinking, lastEventAt: ago(3000) },
    now,
    SILENCE
  ),
  false,
  'a turn still writing reasoning is alive'
);
assert.equal(
  isStallProbeCandidate(
    {
      turnActivity: {
        phase: 'running-tool',
        since: ago(30 * 60_000),
        lastActivityAt: ago(30 * 60_000),
      },
      lastEventAt: ago(30 * 60_000),
    },
    now,
    SILENCE
  ),
  false,
  'a long build is legitimately silent; running-tool belongs to the approval detector'
);
for (const phase of ['idle', 'aborted', 'awaiting-approval', 'interrupted']) {
  assert.equal(
    isStallProbeCandidate(
      {
        turnActivity: {
          phase,
          since: ago(60 * 60_000),
          lastActivityAt: ago(60 * 60_000),
        },
        lastEventAt: ago(60 * 60_000),
      },
      now,
      SILENCE
    ),
    false,
    `${phase} is not a turn in flight and never probes`
  );
}
assert.equal(
  isStallProbeCandidate({ turnActivity: null, lastEventAt: null }, now, SILENCE),
  false,
  'an unbound HUD never captures a pane'
);

// ---- banner recognition --------------------------------------------------

const streamError = [
  'thinking about the failing test',
  '',
  '■ stream error: We are currently experiencing high demand.',
  '',
  '  Ask Codex to do anything',
].join('\n');

assert.equal(
  containsStreamErrorBanner(streamError),
  true,
  'the error line codex leaves above the composer is the durable evidence'
);
assert.equal(
  containsStreamErrorBanner(
    '■ stream error: connection reset; retrying 2/5...'
  ),
  false,
  'an automatic retry recovers on its own and is not an interruption'
);
assert.equal(
  containsStreamErrorBanner('■ Ran npm test — 12 passed'),
  false,
  'an ordinary bulleted status line is not an error'
);
assert.equal(
  containsStreamErrorBanner('stream error: overloaded'),
  false,
  'prose mentioning an error is not the banner; the ■ prefix is required'
);
assert.equal(containsStreamErrorBanner(''), false);
{
  // An error the user already recovered from scrolls up and out of the tail;
  // only what is still on the bottom of the screen counts.
  const scrolledPast = [
    '■ stream error: internal server error',
    ...Array.from({ length: 20 }, (_, index) => `output line ${index}`),
  ].join('\n');
  assert.equal(
    containsStreamErrorBanner(scrolledPast),
    false,
    'an error pushed away by later output no longer describes the session'
  );
}

// ---- detector lifecycle --------------------------------------------------

function detector(screens, options = {}) {
  const captures = [];
  const instance = new StallDetector({
    mainPane: '%42',
    silenceMs: SILENCE,
    probeIntervalMs: 30_000,
    capturePane: async (pane) => {
      captures.push(pane);
      const next = screens.shift();
      return next === undefined ? null : next;
    },
    ...options,
  });
  return { instance, captures };
}

{
  const { instance, captures } = detector([streamError]);
  assert.equal(await instance.refresh(silentThinking, now), true);
  assert.equal(instance.isLikelyInterrupted(), true);
  assert.deepEqual(captures, ['%42'], 'exactly one capture per probe window');

  // The next rollout event proves the turn is alive again; the overlay must
  // clear without waiting for another capture.
  assert.equal(
    await instance.refresh(
      { ...silentThinking, lastEventAt: ago(1000) },
      now + 1000
    ),
    true
  );
  assert.equal(instance.isLikelyInterrupted(), false);
  assert.equal(captures.length, 1, 'recovery costs no capture');
}

{
  // Probing is rate-limited: a 1s scheduler tick must not become a 1s tmux
  // capture loop while the turn stays silent.
  const { instance, captures } = detector([streamError, streamError]);
  await instance.refresh(silentThinking, now);
  await instance.refresh(silentThinking, now + 5_000);
  await instance.refresh(silentThinking, now + 10_000);
  assert.equal(captures.length, 1, 'the probe interval gates repeat captures');
  await instance.refresh(silentThinking, now + 31_000);
  assert.equal(captures.length, 2, 'a probe runs again after the interval');
}

{
  // A tmux timeout returns null. That is not evidence the banner disappeared.
  const { instance } = detector([streamError]);
  await instance.refresh(silentThinking, now);
  assert.equal(instance.isLikelyInterrupted(), true);
  assert.equal(
    await instance.refresh(silentThinking, now + 31_000),
    false,
    'a failed capture reports no change'
  );
  assert.equal(
    instance.isLikelyInterrupted(),
    true,
    'a transient tmux failure does not clear a confirmed banner'
  );
}

{
  // Without a main pane there is nothing to capture; the HUD keeps rendering
  // the parsed phase rather than guessing.
  const { instance, captures } = detector([streamError], { mainPane: undefined });
  assert.equal(await instance.refresh(silentThinking, now), false);
  assert.equal(instance.isLikelyInterrupted(), false);
  assert.equal(captures.length, 0);
}

{
  // Rebinding to another session invalidates an in-flight capture: the screen
  // it read belongs to the previous session.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const instance = new StallDetector({
    mainPane: '%42',
    silenceMs: SILENCE,
    probeIntervalMs: 30_000,
    capturePane: async () => {
      await gate;
      return streamError;
    },
  });
  const pending = instance.refresh(silentThinking, now);
  instance.reset();
  release();
  assert.equal(await pending, false);
  assert.equal(
    instance.isLikelyInterrupted(),
    false,
    'a capture from the previous binding is discarded'
  );
}

console.log('test-stall-detector: PASS');
