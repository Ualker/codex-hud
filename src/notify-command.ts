/** Bounded shell delivery and cleanup for HUD notifications. */
import { spawn } from 'node:child_process';
import { sanitizeDisplayText } from './utils/display-text.js';

/** The user command must not outlive the state it announces. */
const NOTIFY_TIMEOUT_MS = 10_000;

const activeNotifications = new Set<() => void>();

export function stopNotifications(): void {
  for (const stop of activeNotifications) stop();
  activeNotifications.clear();
}
// Covers startup failures and the fatal-error supervisor as well as shutdown.
process.once('exit', stopNotifications);

export function runShellCommand(command: string, payload: string, timeoutMs = NOTIFY_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const processGroup = process.platform !== 'win32';
    const child = spawn('/bin/sh', ['-c', command], {
      detached: processGroup,
      stdio: ['pipe', 'ignore', 'pipe'],
      env: {
        ...process.env,
        CODEX_HUD_EVENT: JSON.parse(payload).event,
        CODEX_HUD_EVENT_JSON: payload,
      },
    });
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;
    const stop = (): void => {
      try {
        if (processGroup && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* The command may have exited just before the timeout. */ }
    };
    activeNotifications.add(stop);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeNotifications.delete(stop);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
      finish(new Error(`Notifier timed out after ${timeoutMs}ms${stderr.length ? `: ${sanitizeDisplayText(stderr.toString('utf8'), 4096)}` : ''}`));
      child.stderr.destroy();
    }, timeoutMs);
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr = Buffer.concat([stderr, chunk.subarray(0, 4096 - stderr.length)]);
    });
    child.on('error', error => finish(error));
    // close waits for inherited pipes too. A shell exiting before its helper
    // does must not cancel the helper's deadline.
    child.on('close', (code, signal) => {
      if (timedOut || code !== 0) {
        const reason = timedOut ? `timed out after ${timeoutMs}ms` : `exited with ${signal ?? `code ${code}`}`;
        finish(new Error(`Notifier ${reason}${stderr.length ? `: ${sanitizeDisplayText(stderr.toString('utf8'), 4096)}` : ''}`));
      } else finish();
    });
    child.stdin.on('error', () => {
      // A command that never reads stdin closes the pipe; not a failure.
    });
    child.stdin.end(payload);
  });
}
