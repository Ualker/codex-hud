import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-process-starts-'));
const originalEnv = { ...process.env }, originalNow = Date.now;
const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
const count = path.join(root, 'calls');
const timestamp = path.join(root, 'timestamp');
fs.writeFileSync(timestamp, 'Mon Jan 1 00:00:00 2024');
fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh
printf x >> "$HUD_TEST_PS_COUNT"
IFS=,
for pid in $4; do printf '%s %s\\n' "$pid" "$(cat "$HUD_TEST_PS_TIME")"; done
`, { mode: 0o755 });
Object.assign(process.env, { HOME: root, CODEX_HOME: root, XDG_STATE_HOME: path.join(root, 'state'), PATH: `${bin}:${process.env.PATH}`, HUD_TEST_PS_COUNT: count, HUD_TEST_PS_TIME: timestamp });
try {
  const { getProcessStartTimesMs } = await import('../../dist/collectors/process-start-times.js');
  const pid = String(process.pid);
  assert.equal((await getProcessStartTimesMs(['bad', ''])).size, 0);
  let now = originalNow(); Date.now = () => now;
  const first = (await getProcessStartTimesMs([pid])).get(pid);
  assert.ok(Number.isFinite(first));
  assert.equal((await getProcessStartTimesMs([pid])).get(pid), first);
  if (process.platform === 'linux') {
    assert.equal(fs.existsSync(count), false, '/proc requires no ps process');
  } else {
    assert.equal(fs.readFileSync(count, 'utf8'), 'x', 'a fresh fact is reused');
    now += 500;
    await getProcessStartTimesMs([pid, String(process.ppid)]);
    assert.equal(fs.readFileSync(count, 'utf8'), 'xx');
    now += 251;
    fs.writeFileSync(timestamp, 'Tue Jan 2 00:00:00 2024');
    assert.notEqual((await getProcessStartTimesMs([pid])).get(pid), first, 'merging another PID must not extend a cached fact deadline');
    assert.equal(fs.readFileSync(count, 'utf8'), 'xxx');
  }
  console.log('test-process-start-times: PASS');
} finally {
  Date.now = originalNow;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  fs.rmSync(root, { recursive: true, force: true });
}
