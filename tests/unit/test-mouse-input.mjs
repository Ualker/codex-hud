import assert from 'node:assert/strict';

import { interpretMouseInput, createMouseInputParser } from '../../dist/utils/mouse-input.js';
import { cycleToolDetailsMode } from '../../dist/render/lines/activity-line.js';

// With mouse reporting on, tmux hands wheel and click events to the pane
// instead of dropping it into copy-mode (which froze the frame). A click
// toggles the view and the wheel cycles tool details, so neither needs the
// pane focused and a key.

const press = (button, x = 10, y = 3) => `\x1b[<${button};${x};${y}M`;
const release = (button, x = 10, y = 3) => `\x1b[<${button};${x};${y}m`;

assert.deepEqual(interpretMouseInput('t'), { handled: false, click: false, wheel: 0 }, 'keys are not mouse input');
assert.deepEqual(interpretMouseInput(press(0)), { handled: true, click: true, wheel: 0 }, 'left press is a click');
assert.deepEqual(interpretMouseInput(release(0)), { handled: true, click: false, wheel: 0 }, 'a release does nothing');
assert.deepEqual(interpretMouseInput(press(2)), { handled: true, click: false, wheel: 0 }, 'right button is ignored');
assert.deepEqual(interpretMouseInput(press(65)), { handled: true, click: false, wheel: 1 }, 'wheel down');
assert.deepEqual(interpretMouseInput(press(64)), { handled: true, click: false, wheel: -1 }, 'wheel up');
assert.deepEqual(
  interpretMouseInput(press(65) + press(65) + press(65)),
  { handled: true, click: false, wheel: 1 },
  'a scaled notch counts once'
);
assert.deepEqual(interpretMouseInput(press(32)), { handled: true, click: false, wheel: 0 }, 'drag motion is ignored');
assert.deepEqual(
  interpretMouseInput(press(0) + release(0)),
  { handled: true, click: true, wheel: 0 },
  'press and release in one read is one click'
);

// The wheel's other direction walks the details cycle backwards.
assert.equal(cycleToolDetailsMode(Date.now(), 1), 'full');
assert.equal(cycleToolDetailsMode(Date.now(), -1), 'targets');
assert.equal(cycleToolDetailsMode(Date.now(), -1), 'off');
assert.equal(cycleToolDetailsMode(Date.now(), 1), 'targets');

const hitTest = (x, y) => y === 1 && x >= 20 && x <= 25;
assert.equal(interpretMouseInput(press(0, 10, 1), hitTest).click, false, 'clicking text does not toggle');
assert.equal(interpretMouseInput(press(0, 20, 1), hitTest).click, true, 'only the displayed button toggles');
for (let split = 1; split < press(0, 20, 1).length; split++) {
  const parse = createMouseInputParser(hitTest);
  const event = press(0, 20, 1);
  const first = parse(event.slice(0, split));
  assert.equal(first.mouse.click, false);
  assert.equal(first.keys, '', 'partial mouse bytes never become keyboard input');
  const second = parse(event.slice(split));
  assert.equal(second.mouse.click, true, `mouse split at byte ${split}`);
  assert.equal(second.keys, '');
}
assert.equal(createMouseInputParser(hitTest)('t').keys, 't');
console.log('test-mouse-input: PASS');
