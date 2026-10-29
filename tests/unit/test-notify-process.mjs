import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runShellCommand } from '../../dist/notify.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-notify-process-'));
const payload = JSON.stringify({ event: 'turn-failed' });
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
try {
  await runShellCommand('cat >/dev/null', payload);
  await assert.rejects(runShellCommand('printf "SYNTHETIC_NOTIFY_ERROR token=secret-value" >&2; exit 23', payload), error => {
    assert.match(error.message, /code 23.*SYNTHETIC_NOTIFY_ERROR/);
    assert.doesNotMatch(error.message, /secret-value/);
    return true;
  });
  await assert.rejects(runShellCommand('hud-command-that-does-not-exist', payload), /code 127/);
  const marker = path.join(root, 'leaked');
  const helper = path.join(root, 'helper.cjs');
  fs.writeFileSync(helper, `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 750);`);
  for (const suffix of [' & wait', ' &']) {
    await assert.rejects(runShellCommand(`${quote(process.execPath)} ${quote(helper)}${suffix}`, payload, 150), /timed out/);
    await new Promise(resolve => setTimeout(resolve, 850));
    assert.equal(fs.existsSync(marker), false, 'timeout must kill descendants even after shell exits');
  }
  const command = `${quote(process.execPath)} ${quote(helper)} & wait`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { runShellCommand } from ${JSON.stringify(new URL('../../dist/notify.js', import.meta.url).href)};
    void runShellCommand(${JSON.stringify(command)}, ${JSON.stringify(payload)}).catch(() => {});
    setTimeout(() => process.exit(0), 150);
  `], { encoding: 'utf8', timeout: 3000 });
  assert.equal(child.status, 0, child.stderr);
  await new Promise(resolve => setTimeout(resolve, 850));
  assert.equal(fs.existsSync(marker), false, 'HUD exit must clean up a still-running notifier');
  console.log('test-notify-process: PASS');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
