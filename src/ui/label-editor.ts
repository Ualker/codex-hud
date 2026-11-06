import { sanitizeTerminalText } from '../render/colors.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** A small end-of-line editor. Paste is text, never a HUD command. */
export class LabelEditor {
  private pending = '';
  private pasting = false;
  private paste = '';

  constructor(public value: string) {}

  input(chunk: string): 'save' | 'cancel' | 'shutdown' | undefined {
    let input = this.pending + chunk;
    this.pending = '';
    while (input) {
      if (this.pasting) {
        const end = input.indexOf('\x1b[201~');
        if (end < 0) {
          // Retain a possible split terminator; keep pasted input bounded.
          const tail = input.lastIndexOf('\x1b');
          if (tail >= 0 && '\x1b[201~'.startsWith(input.slice(tail))) {
            this.pending = input.slice(tail);
            input = input.slice(0, tail);
          }
          this.paste = (this.paste + input).slice(0, 4096);
          return;
        }
        this.append(sanitizeTerminalText(this.paste + input.slice(0, end)));
        this.paste = '';
        this.pasting = false;
        input = input.slice(end + 6);
        continue;
      }
      if (input.startsWith('\x1b[')) {
        const sequence = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(input);
        if (!sequence) { this.pending = input.slice(0, 64); return; }
        if (sequence[0] === '\x1b[200~') this.pasting = true;
        input = input.slice(sequence[0].length);
        continue;
      }
      const character = String.fromCodePoint(input.codePointAt(0)!);
      input = input.slice(character.length);
      if (character === '\x03') return 'shutdown';
      if (character === '\x1b') return 'cancel';
      if (character === '\r' || character === '\n') return 'save';
      if (character === '\x15') this.value = '';
      else if (character === '\x7f' || character === '\b') {
        const parts = [...segmenter.segment(this.value)];
        this.value = parts.slice(0, -1).map(part => part.segment).join('');
      } else if (!/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(character)) {
        this.append(character);
      }
    }
  }

  private append(text: string): void {
    this.value = Array.from(this.value + text).slice(0, 80).join('');
  }
}
