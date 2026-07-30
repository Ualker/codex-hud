import assert from 'node:assert/strict';

process.env.NO_COLOR = '1';
const {
  colors,
  sanitizeTerminalText,
  truncate,
  truncateStart,
  truncateAnsi,
  visualLength,
} = await import('../../dist/render/colors.js');

assert.equal(visualLength('codex'), 5);
assert.equal(visualLength('中文'), 4);
assert.equal(visualLength('e\u0301'), 1);
assert.equal(visualLength('👨‍👩‍👧‍👦'), 2);
assert.equal(truncate('中文状态', 5), '中文…');
assert.equal(visualLength(truncate('中文状态', 5)), 5);
assert.equal(truncateAnsi('A中文B', 4), 'A中…');
assert.equal(visualLength(truncateAnsi('A中文B', 4)), 4);
assert.equal(truncateStart('/很长的目录/codex-hud', 11), '…/codex-hud');
assert.equal(visualLength(truncateStart('/很长的目录/codex-hud', 11)), 11);
assert.equal(colors.red('plain'), 'plain', 'NO_COLOR must suppress ANSI output');
assert.equal(
  sanitizeTerminalText('safe\u001b]0;owned\u0007 \u001b[31mred\u001b[0m \u202Etxt'),
  'safe red txt'
);

console.log('test-terminal-width: PASS');
