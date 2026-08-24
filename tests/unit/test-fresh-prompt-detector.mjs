import assert from 'node:assert/strict';

import {
  FreshPromptDetector,
  containsFreshSessionFooter,
  isFreshPromptProbeCandidate,
  FRESH_PROMPT_PROBE_INTERVAL_MS,
} from '../../dist/collectors/fresh-prompt-detector.js';
import { renderHud } from '../../dist/render/header.js';
import { stripAnsi } from '../../dist/render/colors.js';

const now = Date.parse('2026-08-21T11:07:00.000Z');
const at = (offsetMs) => new Date(now + offsetMs);

// ---- the footer matcher ----------------------------------------------------
// Calibrated live on codex 0.149 (2026-08-21): the composer footer of a fresh
// `/new` session in the very pane whose HUD kept saying "Turn aborted".

const FRESH_FOOTER =
  '  Context 100% left · Ready · Full Access · Fast off';
const composer = (footer) =>
  ['• Some earlier output', '', '› Ask Codex to do anything', '', footer].join(
    '\n'
  );

assert.equal(containsFreshSessionFooter(composer(FRESH_FOOTER)), true);
assert.equal(
  containsFreshSessionFooter(
    composer('  Context 20% left · Thinking · Full Access · Fast off · Tasks 1/3')
  ),
  false,
  'a working session is not a fresh one'
);
assert.equal(
  containsFreshSessionFooter(
    composer('  Context 34% left · Ready · Full Access · Fast off')
  ),
  false,
  'an idle session with history has spent context; Ready alone proves nothing'
);
assert.equal(containsFreshSessionFooter(''), false);
assert.equal(
  containsFreshSessionFooter(
    [FRESH_FOOTER, 'line', 'line', 'line', 'line', 'line', 'last line'].join('\n')
  ),
  false,
  'a footer scrolled out of the last visible lines is history, not state'
);

// ---- candidacy -------------------------------------------------------------

const quietTerminal = (phase) => ({
  turnActivity: { phase, since: at(-3600_000), lastActivityAt: at(-3600_000) },
  lastEventAt: at(-3600_000),
});

assert.equal(isFreshPromptProbeCandidate(quietTerminal('aborted'), now), true);
assert.equal(isFreshPromptProbeCandidate(quietTerminal('idle'), now), true);
assert.equal(
  isFreshPromptProbeCandidate(quietTerminal('interrupted'), now),
  true
);
assert.equal(
  isFreshPromptProbeCandidate(quietTerminal('thinking'), now),
  false,
  'a working phase is live proof the pane runs the bound session'
);
assert.equal(
  isFreshPromptProbeCandidate(quietTerminal('exited'), now),
  false,
  'with Codex gone there is no footer to read'
);
assert.equal(
  isFreshPromptProbeCandidate(
    {
      turnActivity: {
        phase: 'idle',
        since: at(-10_000),
        lastActivityAt: at(-10_000),
      },
      lastEventAt: at(-10_000),
    },
    now
  ),
  false,
  'a fresh turn boundary is not /new; wait out the silence window'
);
assert.equal(isFreshPromptProbeCandidate({}, now), false);

// ---- the detector ----------------------------------------------------------

{
  let screens = [];
  const captured = [];
  const detector = new FreshPromptDetector({
    mainPane: '%17',
    capturePane: async (pane) => {
      captured.push(pane);
      return screens.shift() ?? null;
    },
  });

  // A confirmed fresh footer flips the answer.
  screens = [composer(FRESH_FOOTER)];
  assert.equal(await detector.refresh(quietTerminal('aborted'), now), true);
  assert.equal(detector.isPaneOnFreshSession(), true);
  assert.deepEqual(captured, ['%17']);

  // Inside the probe interval nothing is spawned and the answer holds.
  assert.equal(
    await detector.refresh(quietTerminal('aborted'), now + 1000),
    false
  );
  assert.equal(captured.length, 1);

  // A failed capture is no evidence either way.
  screens = [null];
  assert.equal(
    await detector.refresh(
      quietTerminal('aborted'),
      now + FRESH_PROMPT_PROBE_INTERVAL_MS + 1000
    ),
    false
  );
  assert.equal(detector.isPaneOnFreshSession(), true);

  // A working phase clears the claim without a capture: the first message of
  // the new session rebinds the HUD and the rollout starts moving again.
  const capturesBefore = captured.length;
  assert.equal(
    await detector.refresh(
      {
        turnActivity: {
          phase: 'thinking',
          since: at(0),
          lastActivityAt: at(0),
        },
        lastEventAt: at(0),
      },
      now + FRESH_PROMPT_PROBE_INTERVAL_MS + 2000
    ),
    true
  );
  assert.equal(detector.isPaneOnFreshSession(), false);
  assert.equal(captured.length, capturesBefore, 'clearing costs no capture');
}

{
  // A rebind resets the answer and invalidates an in-flight capture.
  let resolveCapture;
  const detector = new FreshPromptDetector({
    mainPane: '%17',
    capturePane: () =>
      new Promise((resolve) => {
        resolveCapture = resolve;
      }),
  });
  const pending = detector.refresh(quietTerminal('aborted'), now);
  detector.reset();
  resolveCapture(composer(FRESH_FOOTER));
  assert.equal(await pending, false, 'a stale capture cannot set the flag');
  assert.equal(detector.isPaneOnFreshSession(), false);
}

{
  // No main pane, no probes, no claims.
  const detector = new FreshPromptDetector({
    capturePane: async () => composer(FRESH_FOOTER),
  });
  assert.equal(await detector.refresh(quietTerminal('aborted'), now), false);
  assert.equal(detector.isPaneOnFreshSession(), false);
}

// ---- the pane --------------------------------------------------------------

const hudData = (overrides) => ({
  config: {},
  git: { isGitRepo: false },
  project: {
    cwd: '/tmp/x', projectName: 'x',
    agentsMdCount: 0, rulesCount: 0, mcpCount: 0, configsCount: 0,
    extensionsCount: 0, skillsCount: 0, otherAgentSkillsCount: 0,
    hooksCount: 0, globalConfigActive: false,
  },
  sessionStart: at(-3600_000),
  collectorHealth: {},
  displayMode: 'single',
  session: {
    id: '01a02279-adb0-7cb0-a401-1850b1b57692',
    rolloutPath: '/tmp/x/rollout.jsonl',
    startTime: at(-3600_000),
    cwd: '/tmp/x',
  },
  turnActivity: {
    phase: 'aborted',
    since: at(-3600_000),
    lastActivityAt: at(-3600_000),
  },
  ...overrides,
});

const layout = { mode: 'expanded', showDuration: true, barWidth: 8 };
const render = (data) =>
  renderHud(data, { width: 146, showDetails: true, layout, maxLines: 12 })
    .map((line) => stripAnsi(line))
    .join('\n');

{
  const withFlag = render(hudData({ paneFreshSession: true }));
  assert.match(withFlag, /New session at the prompt · binds on its first message/);
  assert.doesNotMatch(
    withFlag,
    /Turn aborted/,
    'the stale state yields the row to what the pane actually shows'
  );

  const withoutFlag = render(hudData({}));
  assert.match(withoutFlag, /Turn aborted/);
  assert.doesNotMatch(withoutFlag, /New session at the prompt/);

  // A working phase outranks a stale flag: the rollout being written is the
  // fresher evidence, whatever the last capture said.
  const working = render(
    hudData({
      paneFreshSession: true,
      turnActivity: {
        phase: 'thinking',
        since: at(-10_000),
        lastActivityAt: at(-1000),
      },
    })
  );
  assert.match(working, /Thinking/);
  assert.doesNotMatch(working, /New session at the prompt/);
}

console.log('test-fresh-prompt-detector: PASS');
