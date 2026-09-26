import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export const DIAGNOSTICS_OPTION = '@codex_hud_diagnostics';
let inFlight = false;
let lastWrite = 0;
export function publishDiagnostics(session: string | undefined, data: object): void {
  if (!session || inFlight || Date.now() - lastWrite < 10000)
    return;
  lastWrite = Date.now();
  inFlight = true;
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, pid: process.pid, node: process.version, updatedAt: new Date(), ...data })).toString('base64');
  void exec('tmux', ['set-option', '-q', '-t', session, DIAGNOSTICS_OPTION, payload], { timeout: 1500, maxBuffer: 16384 })
    .catch(() => { lastWrite = 0; }).finally(() => { inFlight = false; });
}
