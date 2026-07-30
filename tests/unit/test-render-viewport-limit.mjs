import assert from 'node:assert/strict';

import { fitLinesToViewport } from '../../dist/render/index.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';

const lines = [
  'identity',
  'security',
  'context',
  'thinking',
  'agent status with a deliberately long descriptive label',
  'plan',
  'session',
];

const fitted = fitLinesToViewport(lines, 5, 32);
assert.equal(fitted.length, 5);
assert.match(stripAnsi(fitted[4]), /\+2 hidden$/);
assert.match(stripAnsi(fitted[4]), /^agent status/);
for (const line of fitted) {
  assert.ok(visualLength(line) <= 32);
}

console.log('test-render-viewport-limit: PASS');
