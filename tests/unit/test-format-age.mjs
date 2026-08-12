import assert from 'node:assert/strict';

import { formatCompactAge, formatUptime } from '../../dist/utils/format-age.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Single-unit ages used by inline suffixes.
assert.equal(formatCompactAge(0), '0s');
assert.equal(formatCompactAge(59 * SECOND), '59s');
assert.equal(formatCompactAge(MINUTE), '1m');
assert.equal(formatCompactAge(59 * MINUTE + 59 * SECOND), '59m');
assert.equal(formatCompactAge(HOUR), '1h');
assert.equal(formatCompactAge(23 * HOUR + 59 * MINUTE), '23h');

// Two renderers used to cap at hours, so a session idle for a week and a half
// reported "event 284h ago" — measured on a live HUD.
assert.equal(formatCompactAge(DAY), '1d');
assert.equal(formatCompactAge(DAY + 5 * HOUR), '1d5h');
assert.equal(formatCompactAge(284 * HOUR), '11d20h');
assert.equal(formatCompactAge(11 * DAY), '11d', 'a whole number of days omits 0h');

// Clock skew and bad input degrade to zero rather than rendering "-3s".
assert.equal(formatCompactAge(-5000), '0s');
assert.equal(formatCompactAge(Number.NaN), '0s');
assert.equal(formatCompactAge(Number.POSITIVE_INFINITY), '0s');

// Compound uptime keeps the finer unit; it is its row's only time signal.
const base = Date.parse('2026-08-12T00:00:00.000Z');
const upAfter = (ms) => formatUptime(new Date(base), base + ms);
assert.equal(upAfter(0), '0s');
assert.equal(upAfter(45 * SECOND), '45s');
assert.equal(upAfter(3 * MINUTE + 20 * SECOND), '3m');
assert.equal(upAfter(2 * HOUR + 5 * MINUTE), '2h5m');
assert.equal(upAfter(5 * DAY + 17 * HOUR), '5d17h');
assert.equal(upAfter(-1000), '0s', 'a future start renders as just-started');
assert.equal(formatUptime(new Date(Number.NaN), base), '0s');

console.log('test-format-age: PASS');
