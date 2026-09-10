import assert from 'node:assert/strict';

import { renderHud } from '../../dist/render/header.js';
import { renderUsageLine } from '../../dist/render/lines/index.js';
import { stripAnsi } from '../../dist/render/colors.js';

const layout = {
  mode: 'expanded',
  showSeparators: false,
  showDuration: true,
  showContextBreakdown: true,
  barWidth: 12,
};

const now = Date.now();

const project = {
  cwd: '/Users/zyb/Desktop/prj',
  projectName: 'prj',
  agentsMdCount: 0,
  rulesCount: 0,
  mcpCount: 0,
  configsCount: 0,
  extensionsCount: 0,
  skillsCount: 0,
  otherAgentSkillsCount: 0,
  hooksCount: 0,
  globalConfigActive: false,
};

const row1 = (data) =>
  stripAnsi(renderHud(data, { width: 146, showDetails: true, layout, maxLines: 7 })[0]);

// The frame painted before any collector has run. Measured on a cold start it
// is on screen for the first ~200ms of every launch and every --reload, and it
// used to read "[default] prj up 0s" for a session that turned out to be two
// and a half hours old — two confident statements, both wrong.
{
  const provisional = row1({
    config: {},
    git: { isGitRepo: false },
    project,
    sessionStart: new Date(now),
    collectorHealth: { environment: { status: 'pending', lastAttemptAt: new Date(now) } },
    displayMode: 'single',
  });

  assert.equal(
    provisional.includes('default'),
    false,
    '"default" is a model name, not a way of saying we have not looked yet'
  );
  assert.match(provisional, /^prj  …/, 'the unknown model reads as unknown');
  assert.equal(
    provisional.includes('up '),
    false,
    'an unbound HUD has no session whose uptime it could report'
  );
}

// Once the config has been read and sets no model, "default" is a true
// statement about Codex's behavior and stays.
{
  const loaded = row1({
    config: {},
    git: { isGitRepo: false },
    project,
    sessionStart: new Date(now),
    collectorHealth: {},
    displayMode: 'single',
  });
  assert.match(loaded, /^prj  default/);

  // A collector that goes on failing keeps serving its last good snapshot, so
  // what it already read stays true.
  const degraded = row1({
    config: {},
    git: { isGitRepo: false },
    project,
    sessionStart: new Date(now),
    collectorHealth: {
      environment: {
        status: 'error',
        lastAttemptAt: new Date(now),
        lastSuccessAt: new Date(now - 60_000),
        errorSummary: 'worker exited',
      },
    },
    displayMode: 'single',
  });
  assert.match(degraded, /^prj  default/);
}

// Failing before the first success is the same "we have not looked yet" as
// pending: there is no snapshot behind the word.
{
  const neverLoaded = row1({
    config: {},
    git: { isGitRepo: false },
    project,
    sessionStart: new Date(now),
    collectorHealth: {
      environment: {
        status: 'error',
        lastAttemptAt: new Date(now),
        errorSummary: 'worker exited',
      },
    },
    displayMode: 'single',
  });
  assert.match(neverLoaded, /^prj  …/);
}

// Nothing changes for a bound session: its own model wins over both.
{
  const bound = row1({
    config: {},
    git: { isGitRepo: false },
    project,
    sessionStart: new Date(now),
    collectorHealth: { environment: { status: 'pending', lastAttemptAt: new Date(now) } },
    displayMode: 'single',
    session: {
      id: '019ff4e2-1111-2222-3333-444444442ecc',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'max',
      cwd: '/Users/zyb/Desktop/prj',
      startTime: new Date(now - 3 * 3600_000),
    },
  });
  assert.match(bound, /^prj  gpt-5\.6-sol max/);
  assert.match(bound, /up 3h/, 'a bound session does report its uptime');
}

// The uptime cell measures the Codex session, so a session without a start
// time yields the cell rather than substituting the HUD process's own age.
{
  assert.equal(
    renderUsageLine({ sessionStart: new Date(now - 7200_000) }, layout),
    null
  );
  assert.equal(
    stripAnsi(
      renderUsageLine(
        { sessionStart: new Date(now), session: { startTime: new Date(now - 60_000) } },
        layout
      )
    ),
    'up 1m',
    'the session start is the one that counts'
  );
}

console.log('test-provisional-frame: PASS');
