import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hud-quote-'"));
try {
  const wrapper = fs.readFileSync(fileURLToPath(new URL('../../bin/codex-hud', import.meta.url)), 'utf8');
  const start = wrapper.indexOf('build_hud_pane_command() {');
  const end = wrapper.indexOf('\n}\n', start) + 3;
  const checkout = path.join(root, "user's checkout $literal");
  fs.mkdirSync(path.join(checkout, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'bin/codex-hud-renderer'), '#!/bin/bash\nprintf "RENDERER_RAN\\n"\n');
  // An isolated synthetic environment ensures a broken env invocation cannot
  // print any credential belonging to the developer or the agent runtime.
  const env = { PATH: process.env.PATH, HUD_DIR: checkout, SYNTHETIC_SECRET: 'DO_NOT_PRINT' };
  const booleanStart = wrapper.indexOf('parse_boolean_setting() {');
  const booleanEnd = wrapper.indexOf('\n}\n', booleanStart) + 3;
  const script = `${wrapper.slice(booleanStart, booleanEnd)}\nHUD_PASSTHROUGH_ENV_VARS=()\ntmux() { return 0; }\n${wrapper.slice(start, end)}\nbuild_hud_pane_command "$HUD_DIR" '%1' 'codex-hud-fixture' '123' 'Prefix+H' '5' '120'`;
  const built = spawnSync('bash', ['-c', script], { env, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const ran = spawnSync('bash', ['-c', built.stdout], { env, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout, 'RENDERER_RAN\n');
  assert.doesNotMatch(ran.stdout, /DO_NOT_PRINT|SYNTHETIC_SECRET/);
  console.log('test-wrapper-quoted-checkout: PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
