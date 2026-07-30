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

wait_for_count 1

(cd "$ROOT_DIR" && env -u TMUX TMUX_TMPDIR="$TMUX_DIR" \
  "$ROOT_DIR/bin/codex-hud" --toggle-mode >/dev/null)
for _ in $(seq 1 200); do
  [[ -s "$SIGNAL_FILE" ]] && break
  sleep 0.05
done
if [[ ! -s "$SIGNAL_FILE" ]]; then
  echo "Expected --toggle-mode to signal the exact HUD pane process" >&2
  exit 1
fi

(cd "$ROOT_DIR" && env -u TMUX TMUX_TMPDIR="$TMUX_DIR" \
  "$ROOT_DIR/bin/codex-hud" --reload >/dev/null)
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

echo "test-hud-control-commands: PASS"
