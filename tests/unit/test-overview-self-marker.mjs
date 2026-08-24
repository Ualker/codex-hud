import assert from 'node:assert/strict';

import { renderHud } from '../../dist/render/header.js';
import { stripAnsi } from '../../dist/render/colors.js';

const layout = {
  mode: 'expanded',
  showSeparators: false,
  showDuration: true,
  showContextBreakdown: true,
  barWidth: 8,
};

const overview = {
  sessions: [
    {
      id: 'aaaaaaaa-1111-2222-3333-444444444444',
      cwd: '/tmp/proj-a',
      projectName: 'proj-a',
      turnActivity: undefined,
      lastActivityAt: new Date(0),
      contextUsage: undefined,
    },
    {
      id: 'bbbbbbbb-5555-6666-7777-888888888888',
      cwd: '/tmp/proj-b',
      projectName: 'proj-b',
      turnActivity: undefined,
      lastActivityAt: new Date(0),
      contextUsage: undefined,
    },
  ],
  updatedAt: new Date(0),
};

const baseData = {
  config: {},
  project: { cwd: '/tmp/proj-b', projectName: 'proj-b' },
  sessionStart: new Date(0),
  displayMode: 'overview',
  overview,
};

const options = { width: 120, showDetails: true, layout };

const marked = renderHud(
  { ...baseData, overviewSelfSessionId: overview.sessions[1].id },
  options
).map(stripAnsi);
assert.equal(marked.length, 2, 'one row per session');
assert.ok(
  marked[1].startsWith('▸ ') && marked[1].includes('proj-b'),
  `the bound session row carries the marker: ${marked[1]}`
);
assert.ok(
  marked[0].startsWith('  ') && marked[0].includes('proj-a'),
  `other rows stay aligned with a blank marker: ${marked[0]}`
);

// Without a bound session no row is marked, and alignment is unchanged.
const unmarked = renderHud(baseData, options).map(stripAnsi);
assert.ok(
  unmarked.every((row) => row.startsWith('  ')),
  'no marker without a bound session'
);

// A confirmed fresh `/new` prompt outranks the stale phase word: the row's
// state describes the previous session until the first message rebinds it.
const freshRows = renderHud(
  {
    ...baseData,
    overview: {
      sessions: [
        {
          id: 'cccccccc-9999-aaaa-bbbb-cccccccccccc',
          cwd: '/tmp/proj-c',
          projectName: 'proj-c',
          turnActivity: {
            phase: 'idle',
            since: new Date(0),
            lastActivityAt: new Date(0),
          },
          lastActivityAt: new Date(0),
          contextUsage: undefined,
          freshPrompt: true,
        },
      ],
      updatedAt: new Date(0),
    },
  },
  options
).map(stripAnsi);
assert.ok(
  freshRows[0].includes('New prompt'),
  `a fresh-prompt row says so: ${freshRows[0]}`
);
assert.ok(
  !freshRows[0].includes('Idle'),
  'the stale idle word yields to the fresh-prompt mark'
);

console.log('test-overview-self-marker: PASS');
