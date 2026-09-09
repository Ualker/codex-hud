/**
 * SGR mouse reports from the HUD pane: ESC [ < button ; column ; row M
 * (press) or m (release).
 *
 * A click on the displayed [view] button toggles the view and the wheel cycles tool details (down forward,
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

export function interpretMouseInput(
  input: string,
  hitTest: (column: number, row: number) => boolean = () => true
): MouseIntent {
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
      click ||= hitTest(Number(match[2]), Number(match[3]));
    }
  }
  return { handled, click, wheel };
}

/** Stdin chunks can split a mouse report at any byte boundary. */
export function createMouseInputParser(hitTest: (column: number, row: number) => boolean) {
  let pending = '';
  return (chunk: string): { mouse: MouseIntent; keys: string } => {
    let input = pending + chunk;
    pending = '';
    const escape = input.lastIndexOf('\x1b');
    if (escape >= 0) {
      const tail = input.slice(escape);
      if (tail.length <= 48 && /^\x1b(?:\[(?:<\d*(?:;\d*){0,2})?)?$/.test(tail)) {
        pending = tail;
        input = input.slice(0, escape);
      }
    }
    return { mouse: interpretMouseInput(input, hitTest), keys: input.replace(MOUSE_EVENT_PATTERN, '') };
  };
}
