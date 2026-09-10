import assert from 'node:assert/strict';

import {
  CodexLivenessProbe,
  codexCommandInTree,
  isLivenessProbeCandidate,
  treeContainsCodex,
} from '../../dist/collectors/codex-liveness.js';
import {
  renderTurnActivityLine,
  renderBindingHintLine,
} from '../../dist/render/lines/index.js';
import { withDetectorPhases } from '../../dist/utils/detector-phases.js';
import { stripAnsi } from '../../dist/render/colors.js';

const now = Date.parse('2026-08-20T12:00:00.000Z');
const ago = (ms) => new Date(now - ms);

// ---- candidacy ------------------------------------------------------------

const quietIdle = {
  turnActivity: {
    phase: 'idle',
    since: ago(30 * 60_000),
    lastActivityAt: ago(30 * 60_000),
  },
  lastEventAt: ago(30 * 60_000),
};

assert.equal(
  isLivenessProbeCandidate(quietIdle, now),
  true,
  'a quiet idle session is where the exited question exists'
);
assert.equal(
  isLivenessProbeCandidate({ turnActivity: null, lastEventAt: null }, now),
  true,
  'no turn state at all (Waiting/Ready) is the observed live case'
);
assert.equal(
  isLivenessProbeCandidate(
    { ...quietIdle, lastEventAt: ago(5000) },
    now
  ),
  false,
  'a fresh rollout event is free proof of life'
);
for (const phase of [
  'thinking',
  'responding',
  'running-tool',
  'awaiting-approval',
]) {
  assert.equal(
    isLivenessProbeCandidate(
      {
        turnActivity: {
          phase,
          since: ago(60 * 60_000),
          lastActivityAt: ago(60 * 60_000),
        },
        lastEventAt: ago(60 * 60_000),
      },
      now
    ),
    true,
    `${phase} without fresh events can be a crashed process`
  );
}

// A working phase with fresh activity still avoids the process walk, even
// when the caller has not supplied lastEventAt.
assert.equal(isLivenessProbeCandidate({ turnActivity: {
  phase: 'running-tool', since: ago(3600_000), lastActivityAt: ago(1000),
}}, now), false);

for (const phase of ['thinking', 'responding', 'running-tool', 'awaiting-approval', 'idle']) {
  const stale = { phase, since: ago(3600_000), lastActivityAt: ago(3600_000) };
  assert.equal(withDetectorPhases(stale, true, true, true, ago(3600_000), now).phase, 'exited');
  assert.notEqual(withDetectorPhases(stale, false, false, true, ago(1000), now).phase, 'exited',
    'a new rollout write outranks a cached exit flag');
  for (const alive of [true, false, null]) {
    const { instance, probes } = probe([alive]);
    await instance.refresh({ turnActivity: stale, lastEventAt: stale.lastActivityAt }, now);
    assert.equal(probes.length, 1, `${phase}: stale state is probed`);
    assert.equal(instance.isCodexGone(), alive === false, 'silence alone never proves death');
  }
}

// ---- the process-tree walk ------------------------------------------------

// The live-calibrated shape: the pane runs the wrapper's shell command, Codex
// is a node script underneath it, and pane_current_command reads "zsh" the
// whole time. Measured 2026-08-20 (pids from the scratch session).
const liveShape = [
  ' 2689     1 -zsh',
  ' 3590  2689 node /Users/zyb/.nvm/versions/node/v25.8.1/bin/codex',
  ' 2700     1 node /Users/zyb/Desktop/prj/codex-hud/dist/index.js',
].join('\n');

assert.equal(
  treeContainsCodex(liveShape, '2689'),
  true,
  'the node .../bin/codex child form is recognized'
);
assert.equal(
  treeContainsCodex(liveShape, '2700'),
  false,
  'the HUD pane itself contains no Codex'
);

// After quit the wrapper execs the resume shell; the tree is shells only.
const afterQuit = ['2689 1 -zsh', '6631 2689 /bin/zsh'].join('\n');
assert.equal(treeContainsCodex(afterQuit, '2689'), false);

// A native codex binary as a grandchild also counts.
const binaryShape = [
  '10 1 sh -c gate; codex',
  '11 10 /opt/homebrew/bin/codex --model gpt-5.6-sol',
].join('\n');
assert.equal(treeContainsCodex(binaryShape, '10'), true);

// A path merely mentioning codex is not a codex invocation.
const lookalike = ['10 1 zsh', '11 10 tail -f /var/log/codex.log'].join('\n');
assert.equal(treeContainsCodex(lookalike, '10'), false);
assert.equal(treeContainsCodex('', '10'), false);
assert.equal(treeContainsCodex(liveShape, 'not-a-pid'), false);

// The walk hands back the matched invocation itself — the launch flags on it
// are the only policy witness while the session has no rollout.
assert.equal(
  codexCommandInTree(liveShape, '2689'),
  'node /Users/zyb/.nvm/versions/node/v25.8.1/bin/codex'
);
assert.equal(
  codexCommandInTree(binaryShape, '10'),
  '/opt/homebrew/bin/codex --model gpt-5.6-sol'
);
assert.equal(codexCommandInTree(afterQuit, '2689'), undefined);

// ---- probe lifecycle ------------------------------------------------------

function probe(answers, options = {}) {
  const probes = [];
  const instance = new CodexLivenessProbe({
    mainPane: '%15',
    probeIntervalMs: 60_000,
    eventGraceMs: 60_000,
    probePane: async (pane) => {
      probes.push(pane);
      const next = answers.shift();
      if (next === undefined || next === null) {
        return null;
      }
      // Plain booleans stand for command-less probes; objects pass through.
      return typeof next === 'boolean' ? { alive: next } : next;
    },
    ...options,
  });
  return { instance, probes };
}

{
  const { instance, probes } = probe([false]);
  assert.equal(await instance.refresh(quietIdle, now), true);
  assert.equal(instance.isCodexGone(), true);
  assert.deepEqual(probes, ['%15']);

  // The interval gates the next spawn even while the question stays open.
  assert.equal(await instance.refresh(quietIdle, now + 5000), false);
  assert.equal(probes.length, 1, 'no re-spawn inside the probe interval');
}

{
  // Codex coming back (the user typed `codex` in the pane) is seen on the
  // next probe past the interval, and clears the flag.
  const { instance } = probe([false, true]);
  await instance.refresh(quietIdle, now);
  assert.equal(instance.isCodexGone(), true);
  assert.equal(await instance.refresh(quietIdle, now + 61_000), true);
  assert.equal(instance.isCodexGone(), false);
}

{
  // A working phase clears the flag without a spawn: the rollout being
  // written is fresher evidence than a minute-old ps walk.
  const { instance, probes } = probe([false]);
  await instance.refresh(quietIdle, now);
  assert.equal(instance.isCodexGone(), true);
  const changed = await instance.refresh(
    {
      turnActivity: {
        phase: 'thinking',
        since: ago(1000),
        lastActivityAt: ago(1000),
      },
      lastEventAt: ago(1000),
    },
    now + 1000
  );
  assert.equal(changed, true);
  assert.equal(instance.isCodexGone(), false);
  assert.equal(probes.length, 1, 'clearing costs no spawn');
}

{
  // A failed probe is not evidence: tmux busy or ps timing out must not
  // flip the answer either way.
  const { instance } = probe([false, null]);
  await instance.refresh(quietIdle, now);
  assert.equal(instance.isCodexGone(), true);
  assert.equal(await instance.refresh(quietIdle, now + 61_000), false);
  assert.equal(instance.isCodexGone(), true, 'null keeps the last answer');
}

{
  // Rebinding invalidates an in-flight probe: the tree it walked belongs to
  // the previous pane's world.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const instance = new CodexLivenessProbe({
    mainPane: '%15',
    probeIntervalMs: 60_000,
    probePane: async () => {
      await gate;
      return { alive: false };
    },
  });
  const pending = instance.refresh(quietIdle, now);
  instance.reset();
  release();
  assert.equal(await pending, false);
  assert.equal(instance.isCodexGone(), false);
}

{
  // No main pane, no probes, no claims.
  const { instance, probes } = probe([false], { mainPane: undefined });
  assert.equal(await instance.refresh(quietIdle, now), false);
  assert.equal(instance.isCodexGone(), false);
  assert.equal(probes.length, 0);
}

{
  let release;
  const instance = new CodexLivenessProbe({ mainPane: '%15', probePane: () =>
    new Promise((resolve) => { release = resolve; }) });
  const pending = instance.refresh(quietIdle, now);
  await instance.refresh({ ...quietIdle, lastEventAt: ago(1000) }, now);
  release({ alive: false });
  assert.equal(await pending, false);
  assert.equal(instance.isCodexGone(), false, 'late probe cannot overwrite a fresh event');
}

// ---- the command capture --------------------------------------------------
// The invocation's launch flags are the only policy witness while a 0.149
// session has written no rollout; the probe walks the tree anyway, so the
// matched command rides along for free.

{
  const yolo = 'node /x/bin/codex --ask-for-approval never --sandbox danger-full-access';
  const { instance } = probe([
    { alive: true, command: yolo },
    { alive: true, command: yolo },
    { alive: false },
  ]);
  assert.equal(await instance.refresh(quietIdle, now), true);
  assert.equal(instance.getCodexCommand(), yolo);
  assert.equal(instance.isCodexGone(), false);

  // The same sighting twice is not a change.
  assert.equal(await instance.refresh(quietIdle, now + 61_000), false);

  // Codex gone drops the command with the liveness flip.
  assert.equal(await instance.refresh(quietIdle, now + 122_000), true);
  assert.equal(instance.getCodexCommand(), undefined);
}

{
  // A restart with different flags is a change even while alive throughout.
  const { instance } = probe([
    { alive: true, command: 'node /x/bin/codex' },
    { alive: true, command: 'node /x/bin/codex --yolo' },
  ]);
  await instance.refresh(quietIdle, now);
  assert.equal(await instance.refresh(quietIdle, now + 61_000), true);
  assert.equal(instance.getCodexCommand(), 'node /x/bin/codex --yolo');
}

{
  // A failed probe keeps the last sighting, and a rebind forgets it.
  const { instance } = probe([
    { alive: true, command: 'node /x/bin/codex --yolo' },
    null,
  ]);
  await instance.refresh(quietIdle, now);
  assert.equal(await instance.refresh(quietIdle, now + 61_000), false);
  assert.equal(instance.getCodexCommand(), 'node /x/bin/codex --yolo');
  instance.reset();
  assert.equal(instance.getCodexCommand(), undefined);
}

// ---- what the pane says ---------------------------------------------------

const exitedLine = stripAnsi(
  renderTurnActivityLine(
    {
      phase: 'exited',
      since: ago(40 * 60_000),
      lastActivityAt: ago(35 * 60_000),
    },
    146,
    now
  )
);
assert.match(
  exitedLine,
  /Codex exited · run codex to restart/,
  'a dead pane stops claiming to wait for input'
);
assert.match(exitedLine, /event 35m ago/, 'the silence age survives');

const hintBase = {
  config: {},
  git: { isGitRepo: false },
  project: {
    cwd: '/tmp/x', projectName: 'x',
    agentsMdCount: 0, rulesCount: 0, mcpCount: 0, configsCount: 0,
    extensionsCount: 0, skillsCount: 0, otherAgentSkillsCount: 0,
    hooksCount: 0, globalConfigActive: false,
  },
  sessionStart: ago(3600_000),
  collectorHealth: {},
  displayMode: 'single',
};

// Observed live: Codex quit at the trust prompt and the pane kept saying
// "Waiting for a Codex session…" for a process that would never appear.
assert.match(
  stripAnsi(renderBindingHintLine({ ...hintBase, codexExited: true }, 146)),
  /Codex exited · run codex to restart/,
  'the unbound hint stops waiting too'
);
assert.match(
  stripAnsi(renderBindingHintLine(hintBase, 146)),
  /Waiting for a Codex session…/,
  'without the exited signal the original hint stands'
);
assert.match(
  stripAnsi(
    renderBindingHintLine(
      {
        ...hintBase,
        codexExited: true,
        session: { id: 'x', cwd: '/tmp/x', startTime: ago(60_000) },
      },
      146
    )
  ),
  /Codex exited/,
  'a bound session with no turns reports the exit over "ready"'
);

// ---- a live Codex pid answers without a spawn ------------------------------
// The walk hands back the pid it matched; while that pid answers a signal-0
// check, later probes skip the tmux and ps spawns (0.3-5.4s and 0.5-0.8s of
// wall time each on this machine). Its death brings the walk back.
{
  const alive = new Set(['4242']);
  const { instance, probes } = probe(
    [
      { alive: true, command: 'node /x/bin/codex', pid: '4242' },
      { alive: false },
    ],
    { isAlive: (pid) => alive.has(pid) }
  );
  assert.equal(await instance.refresh(quietIdle, now), true, 'the first walk learns the command');
  assert.equal(probes.length, 1);
  assert.equal(await instance.refresh(quietIdle, now + 61_000), false);
  assert.equal(probes.length, 1, 'the live pid answered without a spawn');
  assert.equal(await instance.refresh(quietIdle, now + 122_000), false);
  assert.equal(probes.length, 1);
  alive.delete('4242');
  assert.equal(await instance.refresh(quietIdle, now + 183_000), true, 'the dead pid brings the walk back');
  assert.equal(probes.length, 2);
  assert.equal(instance.isCodexGone(), true);
}

{
  // Without a pid (an older probe shape) every interval still walks.
  const { instance, probes } = probe([{ alive: true, command: 'codex' }, { alive: true, command: 'codex' }]);
  await instance.refresh(quietIdle, now);
  await instance.refresh(quietIdle, now + 61_000);
  assert.equal(probes.length, 2);
}

console.log('test-codex-liveness: PASS');
