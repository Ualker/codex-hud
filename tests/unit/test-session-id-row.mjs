import assert from 'node:assert/strict';

import { renderSessionDetailLine } from '../../dist/render/lines/index.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';

const FULL_ID = '019ff4e2-a2b5-7352-9076-a7e8e9dc2ecc';

const data = {
  config: {},
  git: { isGitRepo: false },
  project: { cwd: '/Users/zyb/Desktop/prj', projectName: 'prj' },
  session: {
    id: FULL_ID,
    cwd: '/Users/zyb/Desktop/prj',
    cliVersion: '0.147.0',
    modelProvider: 'openai',
    startTime: new Date(),
  },
};

const row = (width) => stripAnsi(renderSessionDetailLine(data, width));

// ---- the id is shown in the form that can be used -------------------------
// `codex resume|fork|archive|delete|unarchive` all take the session UUID, so
// this is the one value on the row the user can act on. Abbreviated to
// `019ff4e2…2ecc` it could be read but not typed or copied, while the row was
// using 76 of 146 columns.
{
  const wide = row(146);
  assert.ok(wide.includes(FULL_ID), 'the whole id is on screen when it fits');
  assert.equal(wide.includes('…'), false, 'nothing is elided at this width');
  assert.ok(wide.includes('CLI: 0.147.0'), 'the static cells still fit beside it');
  assert.ok(visualLength(wide) <= 146);
}

// ---- when it stops fitting, the static cells go first ----------------------
{
  const narrow = row(80);
  assert.ok(narrow.includes(FULL_ID), 'the id outranks the CLI version');
  assert.equal(narrow.includes('Provider:'), false);
  assert.ok(visualLength(narrow) <= 80);
}

// ---- below that, the readable short form comes back -----------------------
// A truncated id is worth less than a whole one but more than no id at all.
{
  const tight = row(60);
  assert.ok(tight.includes('019ff4e2…2ecc'), 'the short form is the fallback');
  assert.equal(tight.includes(FULL_ID), false);
  assert.ok(visualLength(tight) <= 60);
}

// ---- and the row never overflows at any width -----------------------------
{
  for (let width = 10; width <= 160; width++) {
    const line = renderSessionDetailLine(data, width);
    if (line === null) {
      continue;
    }
    assert.ok(
      visualLength(stripAnsi(line)) <= width,
      `the row honors its budget at ${width}`
    );
  }
}

// ---- an unbound HUD still describes where it is ---------------------------
{
  const unbound = stripAnsi(
    renderSessionDetailLine(
      { config: {}, git: { isGitRepo: false }, project: { cwd: '/tmp/x', projectName: 'x' } },
      146
    )
  );
  assert.equal(unbound, 'Dir: /tmp/x');
}

console.log('test-session-id-row: PASS');
