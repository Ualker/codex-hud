import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rateLimitNotificationScope } from '../../dist/notify.js';
const exec = promisify(execFile);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-notify-many-'));
const module = new URL('../../dist/notify.js', import.meta.url).href;
const run = async (scope, command = 'test') => {
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', `
    import { HudNotifier } from ${JSON.stringify(module)};
    const context = {cwd: '/', quotaScope: ${JSON.stringify(scope)}};
    const quiet = {'approval-needed':false,'limit-reached':false,'turn-completed':false,'turn-failed':false,'turn-interrupted':false};
    const notifier = new HudNotifier({command: ${JSON.stringify(command)}, runCommand:async()=>console.log('sent')});
    notifier.observe(quiet, context);
    notifier.observe({...quiet,'limit-reached':true}, context);
  `], { env: { ...process.env, HOME: root, XDG_STATE_HOME: path.join(root, 'state'), CODEX_HUD_LOG_FILE: 'off' } });
  return stdout.trim();
};
try {
  assert.equal((await Promise.all(Array.from({ length: 8 }, () => run('account-a/window-1')))).filter(Boolean).length, 1);
  assert.equal(await run('account-a/window-1'), '', 'restart does not repeat a claimed window');
  assert.equal(await run('account-a/window-2'), 'sent', 'a new window notifies');
  assert.equal(await run('account-b/window-1'), 'sent', 'accounts remain independent');
  assert.equal(await run('account-a/window-1', 'another-destination'), 'sent', 'notification destinations remain independent');
  assert.notEqual(rateLimitNotificationScope('account-a', undefined, 0), rateLimitNotificationScope('account-a', undefined, 86400000), 'windowless claims expire by day');
  const dated = { primary: { resets_at: 100000 } };
  assert.equal(rateLimitNotificationScope('account-a', dated, 0), rateLimitNotificationScope('account-a', dated, 86400000), 'known windows retain their scope across days');
  console.log('test-quota-notify-multiprocess: PASS');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
