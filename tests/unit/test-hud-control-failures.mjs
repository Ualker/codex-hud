import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const wrapper = fs.readFileSync(new URL('../../bin/codex-hud', import.meta.url), 'utf8');
const definition = (name) => {
  const match = wrapper.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
  assert.ok(match, `wrapper function ${name} exists`);
  return match[0];
};

// Exercise the actual functions in the conditional contexts that disable
// Bash errexit. Stub only the tmux boundary, never the function under test.
const script = `set -e
info() { echo "$*"; }
warn() { echo "$*" >&2; }
error() { echo "$*" >&2; exit 1; }
pane_exists_in_session() { return 0; }
get_main_pane_id_for_session() { echo %1; }
resolve_hud_height_for_tmux_target() { HUD_HEIGHT=6; }
set_fixed_hud_height() { [[ "$FAILURE" != height ]]; }
build_hud_pane_command() { [[ "$FAILURE" != command ]] || return 1; echo 'node /hud/dist/index.js'; }
build_hud() { return 0; }
wait_for_hud_process() { [[ "$FAILURE" != startup ]]; }
find_all_hud_sessions() { printf 'first\nsecond\n'; }
tmux() {
  case "$1" in
    show-option)
      case "\${@: -1}" in
        @codex_hud_pane) echo %2 ;;
        @codex_hud_cwd) [[ "$STORED" == yes ]] && echo /work || true ;;
        @codex_hud_session_start) [[ "$STORED" == yes ]] && echo 100 || true ;;
      esac ;;
    display) echo 80 ;;
    respawn-pane)
      echo "RESPAWN $session_name" >&2
      [[ "$FAILURE" != respawn && !( "$FAILURE" == partial && "$session_name" == second ) ]] ;;
  esac
}
${definition('reload_hud_pane_for_session')}
${definition('reload_hud_all')}
if [[ "$SCOPE" == all ]]; then
  if reload_hud_all; then exit 0; else exit 1; fi
else
  if ! reload_hud_pane_for_session first; then exit 1; fi
fi
`;
for (const stored of ['yes', 'no']) {
  for (const failure of ['none', 'respawn', 'startup', 'height', ...(stored === 'yes' ? ['command'] : [])]) {
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8',
      env: { ...process.env, STORED: stored, FAILURE: failure, SCOPE: 'one' } });
    assert.equal(result.status, failure === 'none' ? 0 : 1, `${stored}/${failure}: ${result.stderr}`);
    assert.equal(result.stdout.includes('Reloaded HUD pane'), failure === 'none', 'failure never reports success');
    if (failure === 'height' || failure === 'command') {
      assert.doesNotMatch(result.stderr, /RESPAWN/, 'preparation failure must not kill the old HUD');
    }
  }
}
const partial = spawnSync('bash', ['-c', script], { encoding: 'utf8',
  env: { ...process.env, STORED: 'yes', FAILURE: 'partial', SCOPE: 'all' } });
assert.equal(partial.status, 1, 'partial reload failure is a failing command');
assert.match(partial.stdout, /1 succeeded, 1 failed/);
assert.doesNotMatch(partial.stdout, /Reloaded HUD pane in session: second/);

// Large unrelated trees cannot steal a control signal; descendants may occur
// before their parents in ps output, and a shell parent remains supported.
const rows = Array.from({ length: 2000 }, (_, i) => `${10000 + i} 1 00:01 node node /other/dist/index.js`);
rows.push('43 42 00:02 node node /hud/dist/index.js.bak', '44 42 00:03 node node /hud/dist/index.js', '42 1 00:04 zsh /bin/zsh');
const walked = spawnSync('bash', ['-c', `${definition('hud_process_from_table')}\nhud_process_from_table 42`], {
  encoding: 'utf8', input: rows.reverse().join('\n') + '\n', timeout: 5000,
});
assert.equal(walked.status, 0, walked.stderr);
assert.equal(walked.stdout.trim(), '44 00:03');
console.log('test-hud-control-failures: PASS');
