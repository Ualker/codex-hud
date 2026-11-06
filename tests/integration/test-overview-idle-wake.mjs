import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Real collectors and timers on a private tmux server: a short idle must not
// hide a fresh turn behind two consecutive five-second cache/cadence gates.
const result = spawnSync(process.execPath, [
  'scripts/benchmark-runtime.mjs', '--instances', '1', '--seconds', '12',
  '--idle-seconds', '15', '--wake-seconds', '8',
], { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8', timeout: 60_000 });
assert.equal(result.status, 0, result.stderr || String(result.error));
const report = JSON.parse(result.stdout);
assert.equal(report.runs.length, 1);
assert.ok(report.runs[0].wakeLatencyMs < 8000);
assert.equal(report.runs[0].metrics[0].sqlite.failures, 0);
console.log(`test-overview-idle-wake: PASS (wake=${report.runs[0].wakeLatencyMs}ms)`);
