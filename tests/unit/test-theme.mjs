import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const script = `const {theme} = await import('./dist/render/colors.js'); console.log(JSON.stringify(['model','info','warning','error'].map(key=>theme[key](key))));`;
const render = overrides => {
  const env = { ...process.env, TERM: 'xterm-256color', NO_COLOR: '', CODEX_HUD_THEME: '', CODEX_HUD_TMUX_STYLE: '', ...overrides };
  if (env.CODEX_HUD_THEME === '') delete env.CODEX_HUD_THEME;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
const themed = render({ CODEX_HUD_THEME: 'blue-purple' });
assert.match(themed[0], /38;2;185;163;227m/);
assert.match(themed[1], /38;2;146;180;255m/);
assert.match(themed[2], /\x1b\[33m/);
assert.match(themed[3], /\x1b\[31m/);
assert.deepEqual(render({ CODEX_HUD_TMUX_STYLE: 'blue-purple' }), themed);
assert.deepEqual(render({ CODEX_HUD_THEME: 'blue-purple', NO_COLOR: '1' }), ['model', 'info', 'warning', 'error']);
assert.match(render({ CODEX_HUD_THEME: 'default' })[0], /\x1b\[36m/);
console.log('test-theme: PASS');
