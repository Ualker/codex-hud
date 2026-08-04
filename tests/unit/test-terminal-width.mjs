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

// OSC 8 hyperlinks occupy zero cells and truncation must close open links.
const linked = ']8;;file://host/tmp/repo\\repo-name]8;;\\';
assert.equal(visualLength(linked), 9, 'hyperlink wrapper adds no visual width');
assert.equal(truncateAnsi(linked, 100), linked, 'short linked text passes through');
const truncatedLink = truncateAnsi(`${linked} tail-content`, 12);
assert.equal(visualLength(truncatedLink), 12);
assert.ok(
  truncatedLink.includes(']8;;file://host/tmp/repo\\'),
  'link opener survives truncation'
);
const openerCount = truncatedLink.split(']8;;').length - 1;
assert.ok(
  openerCount % 2 === 0,
  'every OSC 8 opener is matched by a closer after truncation'
);

console.log('test-terminal-width: PASS');
