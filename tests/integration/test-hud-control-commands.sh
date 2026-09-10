#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
TMUX_DIR="$TEST_ROOT/tmux"
COUNTER_FILE="$TEST_ROOT/starts"
SIGNAL_FILE="$TEST_ROOT/toggled"
HELPER_FILE="$TEST_ROOT/dist/index.js"

cleanup() {
  env -u TMUX TMUX_TMPDIR="$TMUX_DIR" tmux kill-server >/dev/null 2>&1 || true
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

mkdir -p "$TMUX_DIR" "$(dirname "$HELPER_FILE")"

cat > "$HELPER_FILE" <<'EOF'
import fs from 'node:fs';

const counterFile = process.env.HUD_TEST_COUNTER;
const signalFile = process.env.HUD_TEST_SIGNAL;
if (!counterFile || !signalFile) {
  process.exit(2);
}

let count = 0;
try {
  count = Number(fs.readFileSync(counterFile, 'utf8')) || 0;
} catch {
  // First start.
}
fs.writeFileSync(counterFile, String(count + 1));

process.on('SIGUSR1', () => {
  fs.appendFileSync(signalFile, 'toggle\n');
});
process.on('SIGUSR2', () => {
  fs.appendFileSync(signalFile, 'details\n');
});

setInterval(() => {}, 1000);
EOF

hash_cwd() {
  local cwd="$1"
  if command -v md5sum >/dev/null 2>&1; then
    printf "%s" "$cwd" | md5sum | awk '{print substr($1, 1, 8)}'
  elif command -v md5 >/dev/null 2>&1; then
    printf "%s" "$cwd" | md5 -q 2>/dev/null | cut -c1-8
  else
    printf "%s" "$cwd" | shasum -a 256 | awk '{print substr($1, 1, 8)}'
  fi
}

wait_for_count() {
  local expected="$1"
  for _ in $(seq 1 200); do
    if [[ -f "$COUNTER_FILE" ]] && [[ "$(cat "$COUNTER_FILE")" -ge "$expected" ]]; then
      return 0
    fi
    sleep 0.05
  done
  echo "Expected HUD fixture start count >= $expected" >&2
  return 1
}

session_hash="$(hash_cwd "$ROOT_DIR")"
session_name="codex-hud-codex-hud-${session_hash}-20990101000000-test"
node_path="$(command -v node)"
helper_escaped="$(printf '%q' "$HELPER_FILE")"
counter_escaped="$(printf '%q' "$COUNTER_FILE")"
signal_escaped="$(printf '%q' "$SIGNAL_FILE")"
node_escaped="$(printf '%q' "$node_path")"
# Keep a shell parent to cover sessions created before the HUD command started
# using exec. --toggle-mode must find the exact Node descendant, not signal sh.
fixture_command="env HUD_TEST_COUNTER=$counter_escaped HUD_TEST_SIGNAL=$signal_escaped $node_escaped $helper_escaped & wait"

env -u TMUX TMUX_TMPDIR="$TMUX_DIR" tmux -f /dev/null \
  new-session -d -s "$session_name" "$fixture_command"
hud_pane="$(env -u TMUX TMUX_TMPDIR="$TMUX_DIR" \
  tmux list-panes -t "$session_name" -F '#{pane_id}' | head -n1)"
env -u TMUX TMUX_TMPDIR="$TMUX_DIR" \
  tmux set-option -t "$session_name" -q @codex_hud_pane "$hud_pane"

main_pane="$(env -u TMUX TMUX_TMPDIR="$TMUX_DIR" tmux split-window -d -t "$session_name" -P -F '#{pane_id}' 'sleep 120')"
env -u TMUX TMUX_TMPDIR="$TMUX_DIR" tmux set-option -t "$session_name" @codex_hud_main_pane "$main_pane"
main_pid="$(env -u TMUX TMUX_TMPDIR="$TMUX_DIR" tmux display-message -p -t "$main_pane" '#{pane_pid}')"

wait_for_count 1

# A newer sibling must not steal controls from the current pane. Every
# control also rejects ambiguous external selection before sending anything.
other_session="codex-hud-codex-hud-${session_hash}-20990102000000-other"
env -u TMUX TMUX_TMPDIR="$TMUX_DIR" tmux new-session -d -s "$other_session" 'sleep 120'
for control in --kill --reload --toggle-mode --cycle-details; do
  if (cd "$ROOT_DIR" && env -u TMUX -u TMUX_PANE TMUX_TMPDIR="$TMUX_DIR" \
      "$ROOT_DIR/bin/codex-hud" "$control" >"$TEST_ROOT/ambiguous.log" 2>&1); then
    echo "Expected $control to reject ambiguous selection" >&2
    exit 1
  fi
  grep -q -- '--target' "$TEST_ROOT/ambiguous.log"
done
fixture_socket="$(env -u TMUX TMUX_TMPDIR="$TMUX_DIR" tmux display-message -p -t "$hud_pane" '#{socket_path}')"

(cd "$ROOT_DIR" && env TMUX="$fixture_socket,0,0" TMUX_PANE="$hud_pane" TMUX_TMPDIR="$TMUX_DIR" \
  "$ROOT_DIR/bin/codex-hud" --toggle-mode >/dev/null)
for _ in $(seq 1 200); do
  [[ -s "$SIGNAL_FILE" ]] && break
  sleep 0.05
done
if [[ ! -s "$SIGNAL_FILE" ]]; then
  echo "Expected --toggle-mode to signal the exact HUD pane process" >&2
  exit 1
fi

# --cycle-details is the `t` key without focusing the pane: USR2 to the same
# process.
(cd "$ROOT_DIR" && env -u TMUX TMUX_TMPDIR="$TMUX_DIR" \
  "$ROOT_DIR/bin/codex-hud" --cycle-details --target "$session_name" >/dev/null)
for _ in $(seq 1 200); do
  grep -q '^details$' "$SIGNAL_FILE" 2>/dev/null && break
  sleep 0.05
done
if ! grep -q '^details$' "$SIGNAL_FILE"; then
  echo "Expected --cycle-details to signal the HUD pane process with USR2" >&2
  exit 1
fi

(cd "$ROOT_DIR" && env -u TMUX TMUX_TMPDIR="$TMUX_DIR" \
  "$ROOT_DIR/bin/codex-hud" --reload --target "$hud_pane" >/dev/null)
wait_for_count 2

adaptive_height="$(env -u TMUX TMUX_TMPDIR="$TMUX_DIR" \
  tmux show-option -t "$session_name" -qv @codex_hud_height_adaptive)"
adaptive_width="$(env -u TMUX TMUX_TMPDIR="$TMUX_DIR" \
  tmux show-option -t "$session_name" -qv @codex_hud_auto)"
resolved_height="$(env -u TMUX TMUX_TMPDIR="$TMUX_DIR" \
  tmux show-option -t "$session_name" -qv @codex_hud_height)"
if [[ "$adaptive_height" != "1" || "$adaptive_width" != "1" ]]; then
  echo "Expected --reload to migrate legacy sessions to adaptive HUD sizing" >&2
  exit 1
fi
if ! [[ "$resolved_height" =~ ^[0-9]+$ ]] || \
  [[ "$resolved_height" -lt 5 || "$resolved_height" -gt 12 ]]; then
  echo "Expected --reload to resolve a bounded HUD height, got: $resolved_height" >&2
  exit 1
fi

if ! env -u TMUX TMUX_TMPDIR="$TMUX_DIR" \
  tmux has-session -t "$session_name" 2>/dev/null; then
  echo "HUD control commands must not terminate the tmux session" >&2
  exit 1
fi

env -u TMUX TMUX_TMPDIR="$TMUX_DIR" tmux has-session -t "$other_session"
# An accepted respawn whose command immediately exits must fail readiness.
env -u TMUX TMUX_TMPDIR="$TMUX_DIR" tmux set-window-option -t "$session_name" remain-on-exit on
env -u TMUX TMUX_TMPDIR="$TMUX_DIR" tmux respawn-pane -k -t "$hud_pane" 'exit 17'
if (cd "$ROOT_DIR" && env -u TMUX TMUX_TMPDIR="$TMUX_DIR" \
  "$ROOT_DIR/bin/codex-hud" --reload --target "$session_name" >"$TEST_ROOT/failed-start.log" 2>&1); then
  echo "A HUD that exits on startup must not report reload success" >&2
  exit 1
fi
if grep -q 'Reloaded HUD pane' "$TEST_ROOT/failed-start.log"; then
  cat "$TEST_ROOT/failed-start.log" >&2
  exit 1
fi
[[ "$(env -u TMUX TMUX_TMPDIR="$TMUX_DIR" tmux display-message -p -t "$main_pane" '#{pane_pid}')" == "$main_pid" ]]
kill -0 "$main_pid"
env -u TMUX TMUX_TMPDIR="$TMUX_DIR" tmux has-session -t "$other_session"
echo "test-hud-control-commands: PASS"
