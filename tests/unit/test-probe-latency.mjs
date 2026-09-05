import assert from 'node:assert/strict';

import {
  resetProbeLatency,
  slowProbes,
  startProbe,
} from '../../dist/utils/probe-latency.js';
import { renderNoteLine } from '../../dist/render/lines/index.js';
import { stripAnsi } from '../../dist/render/colors.js';

// On a loaded machine a tmux round trip measured 0.3-5.4s; past its budget
// every consumer degrades silently while the pane looks healthy. The recent
// durations make that visible as a dim note.

let clock = 1_000_000;
const now = () => clock;

resetProbeLatency();
{
  const finish = startProbe('tmux', now);
  clock += 5400;
  finish();
  finish(); // a second call is ignored
  const finishFast = startProbe('git', now);
  clock += 90;
  finishFast();
  assert.deepEqual(slowProbes(clock), [{ name: 'tmux', ms: 5400 }], 'only the slow one is listed');
  assert.deepEqual(slowProbes(clock + 61_000), [], 'a slow sample ages out after a minute');
}

{
  resetProbeLatency();
  const a = startProbe('ps', now);
  clock += 2500;
  a();
  const b = startProbe('tmux', now);
  clock += 4000;
  b();
  assert.deepEqual(
    slowProbes(clock).map((probe) => probe.name),
    ['tmux', 'ps'],
    'slowest first'
  );
  // A later fast sample clears the probe from the list.
  const c = startProbe('tmux', now);
  clock += 100;
  c();
  assert.deepEqual(slowProbes(clock).map((probe) => probe.name), ['ps']);
}

// ---- the note row names the slowest probe --------------------------------------
{
  const base = { config: {}, git: { isGitRepo: false }, project: { cwd: '/x', projectName: 'x' } };
  assert.equal(renderNoteLine(base, 100), null, 'nothing to note, no row');
  const noted = stripAnsi(
    renderNoteLine({ ...base, slowProbes: [{ name: 'tmux', ms: 5400 }, { name: 'ps', ms: 2100 }] }, 100)
  );
  assert.match(noted, /^⚠ probes slow · tmux 5\.4s$/);
  const both = stripAnsi(
    renderNoteLine(
      {
        ...base,
        slowProbes: [{ name: 'tmux', ms: 5400 }],
        protocolHealth: {
          unknownTopLevelTypes: { token_usage_record: 2 },
          unknownResponseTypes: {},
          unknownEventTypes: {},
          malformedLines: 0,
        },
      },
      120
    )
  );
  assert.match(both, /2 unrecognized Codex records: token_usage_record · probes slow · tmux 5\.4s/);
}

console.log('test-probe-latency: PASS');
