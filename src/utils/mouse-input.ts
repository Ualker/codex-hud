/**
 * SGR mouse reports from the HUD pane: ESC [ < button ; column ; row M
 * (press) or m (release).
 *
 * A click toggles the view and the wheel cycles tool details (down forward,
 * up back), so neither needs the pane focused and a key. Motion, releases and
 * other buttons are ignored; several wheel reports in one read (terminals
 * scale a notch) count once.
 */

const MOUSE_EVENT_PATTERN = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

export interface MouseIntent {
  /** The input carried at least one mouse report. */
  handled: boolean;
  /** A left-button press. */
  click: boolean;
  /** 1 wheel down, -1 wheel up, 0 none. */
  wheel: 0 | 1 | -1;
}

export function interpretMouseInput(input: string): MouseIntent {
  let handled = false;
  let click = false;
  let wheel: 0 | 1 | -1 = 0;
  for (const match of input.matchAll(MOUSE_EVENT_PATTERN)) {
    handled = true;
    const button = Number(match[1]);
    const pressed = match[4] === 'M';
    if (button & 32) {
      continue; // motion while a button is held
    }
    if (button === 64) {
      wheel = -1;
    } else if (button === 65) {
      wheel = 1;
    } else if (pressed && button < 64 && (button & 3) === 0) {
      click = true;
    }
  }
  return { handled, click, wheel };
}
