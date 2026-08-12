import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// colors.ts reads the environment once at module load, so each case needs a
// fresh process rather than a mutated process.env.
const distColors = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dist',
  'render',
  'colors.js'
);

function colorized(env) {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const { colors } = await import(${JSON.stringify(distColors)});
       process.stdout.write(colors.red('x'));`,
    ],
    { env: { ...process.env, ...env }, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.includes('\x1b[');
}

const baseline = { NO_COLOR: undefined, TERM: 'xterm-256color' };

assert.equal(colorized(baseline), true, 'color renders by default');

// The convention is that NO_COLOR disables color when it is present *and
// non-empty*; an empty value explicitly means "not set". Treating "" as set
// stripped color from anyone who exported the variable without a value.
assert.equal(
  colorized({ ...baseline, NO_COLOR: '' }),
  true,
  'an empty NO_COLOR means unset and must keep color'
);
assert.equal(
  colorized({ ...baseline, NO_COLOR: '1' }),
  false,
  'a non-empty NO_COLOR disables color'
);
assert.equal(
  colorized({ ...baseline, NO_COLOR: 'anything' }),
  false,
  'any non-empty value counts, per the convention'
);

assert.equal(
  colorized({ ...baseline, TERM: 'dumb' }),
  false,
  'a dumb terminal still disables color'
);

console.log('test-no-color-env: PASS');
