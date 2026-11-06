import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../..', import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hud-scope-')));
const a = path.join(root, 'project-a'), b = path.join(root, 'project b');
for (const dir of [a, b, 'home/.codex/sessions', 'tmux'].map(p => path.isAbsolute(p) ? p : path.join(root, p))) fs.mkdirSync(dir, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TMUX|CODEX_|CMUX_|XDG_)/.test(key)));
Object.assign(env, { HOME: path.join(root, 'home'), SHELL: '/bin/sh', TERM: 'xterm-256color', TMUX_TMPDIR: path.join(root, 'tmux'), HUD_SCOPE_REPO: repo });
const tmux = (...args) => execFileSync('tmux', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }).trim();
const source = fs.readFileSync(path.join(repo, 'bin/codex-hud'), 'utf8').split('# HUD options precede Codex arguments, whose own parsing remains untouched.')[0];
const functions = path.join(root, 'functions.sh');
fs.writeFileSync(functions, source);
env.HUD_SCOPE_FUNCTIONS = functions;
const name = `codex-hud-project-a-${createHash('md5').update(a).digest('hex').slice(0, 8)}-20260101000000-1`;
function select(cwd) {
  return execFileSync('/bin/bash', ['-c', `source "$HUD_SCOPE_FUNCTIONS"
    HUD_DIR="$HUD_SCOPE_REPO"
    if claim_detached_session; then
      printf 'attach=%s\n' "$SESSION_NAME"
      release_session_claim "$CLAIMED_SESSION" "$ATTACH_OWNER"
    fi
    if selected=$(resolve_control_session 2>/dev/null); then printf 'control=%s\n' "$selected"; fi
    find_all_hud_sessions | while IFS= read -r selected; do printf 'all=%s\n' "$selected"; done
  `], { cwd, env: { ...env, PWD: cwd }, encoding: 'utf8', timeout: 10000 }).trim();
}
try {
  const main = tmux('-f', '/dev/null', 'new-session', '-d', '-s', name, '-P', '-F', '#{pane_id}', 'exec sleep 120');
  const pid = tmux('display-message', '-p', '-t', main, '#{pane_pid}');
  const namespace = execFileSync(process.execPath, [path.join(repo, 'dist/namespace.js'), '', '', env.HOME, a], { env, encoding: 'utf8' }).trim();
  tmux('set-option', '-t', name, '@codex_hud_namespace', namespace);
  tmux('set-option', '-t', name, '@codex_hud_cwd', b);
  const decoy = 'codex-hud-other-account';
  tmux('new-session', '-d', '-s', decoy, 'exec sleep 120');
  tmux('set-option', '-t', decoy, '@codex_hud_cwd', b);
  tmux('set-option', '-t', decoy, '@codex_hud_namespace', '0000000000000000');
  assert.equal(select(a), '', 'launch directory no longer owns a moved session');
  assert.equal(select(b), `attach=${name}\ncontrol=${name}\nall=${name}`, 'all selectors share runtime cwd and namespace');
  const alias = path.join(root, 'alias'); fs.symlinkSync(b, alias);
  assert.equal(select(alias), select(b), 'directory aliases use canonical paths');
  tmux('set-option', '-u', '-t', name, '@codex_hud_cwd');
  assert.match(select(a), new RegExp(`attach=${name}`), 'legacy sessions retain name fallback');
  assert.equal(tmux('display-message', '-p', '-t', main, '#{pane_pid}'), pid);
  assert.equal(tmux('display-message', '-p', '-t', main, '#{pane_dead}'), '0');
  console.log('test-session-current-cwd-scope: PASS');
} finally { try { tmux('kill-server'); } catch {} fs.rmSync(root, { recursive: true, force: true }); }
