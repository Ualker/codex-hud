import { writeSync } from 'node:fs';
import { logHudError } from './hud-log.js';
/** The renderer supervisor alone interprets 75 as a recoverable process crash. */
export const HUD_FATAL_EXIT = 75;
export function installFatalHandlers(): void {
  let failing = false;
  const fail = (scope: string, error: unknown): never => {
    if (!failing) {
      failing = true;
      try {
        logHudError(scope, error);
      }
      catch { /* Last-resort path. */ }
      try {
        if (process.stdin.isTTY)
          process.stdin.setRawMode(false);
        writeSync(1, '\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[H\x1b[2KHUD stopped after an unexpected error; restarting…\n');
      }
      catch { /* No asynchronous work in a damaged process. */ }
    }
    process.exit(HUD_FATAL_EXIT);
  };
  process.on('uncaughtException', error => fail('uncaught-exception', error));
  process.on('unhandledRejection', error => fail('unhandled-rejection', error));
}
