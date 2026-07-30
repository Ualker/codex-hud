#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
FAKE_TMUX_DIR="$SCRIPT_DIR/fake-tmux"
TEST_ROOT="$(mktemp -d)"
FAKE_BIN_DIR="$TEST_ROOT/bin"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

mkdir -p "$FAKE_BIN_DIR"
for command_name in codex npm; do
  cat > "$FAKE_BIN_DIR/$command_name" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE
  chmod +x "$FAKE_BIN_DIR/$command_name"
done

cat > "$FAKE_BIN_DIR/node" <<'FAKE'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then
  echo "v20.19.0"
fi
exit 0
FAKE
cat > "$FAKE_BIN_DIR/tput" <<'FAKE'
#!/usr/bin/env bash
case "${1:-}" in
  lines) echo "24" ;;
  cols) echo "100" ;;
  *) echo "0" ;;
esac
FAKE
chmod +x "$FAKE_BIN_DIR/node" "$FAKE_BIN_DIR/tput"

run_wrapper() {
  local limit="$1"
  local log_file="$2"
  env \
    PATH="$FAKE_BIN_DIR:$FAKE_TMUX_DIR:$PATH" \
    CODEX_HUD_HEIGHT=5 \
    CODEX_HUD_HEIGHT_AUTO=0 \
    CODEX_HUD_HISTORY_LIMIT="$limit" \
    TMUX_LOG_FILE="$log_file" \
    TMUX_MAIN_PANE_ID="%1" \
    TMUX_PANE_ID="%2" \
    TMUX_PANES=$'%1\n%2' \
    TMUX_SPLIT_PANE_ID="%2" \
    TMUX_SHOW_OPTION_DEFAULT="50000" \
    TMUX_PANE_WIDTH="100" \
    TMUX_PANE_HEIGHT="5" \
    "$ROOT_DIR/bin/codex-hud" --new-session
}

valid_log="$TEST_ROOT/valid.log"
run_wrapper 10000 "$valid_log" >/dev/null

lower_line="$(grep -n 'set-option .* history-limit 10000$' "$valid_log" | head -n1 | cut -d: -f1)"
split_line="$(grep -n '^split-window ' "$valid_log" | head -n1 | cut -d: -f1)"
restore_line="$(grep -n 'set-option .* history-limit 50000$' "$valid_log" | tail -n1 | cut -d: -f1)"
if [[ -z "$lower_line" || -z "$split_line" || -z "$restore_line" ]] || \
   (( lower_line >= split_line || split_line >= restore_line )); then
  echo "Expected HUD-only history limit followed by inherited-value restore" >&2
  cat "$valid_log" >&2
  exit 1
fi
if grep -q 'history-limit 200000' "$valid_log"; then
  echo "Legacy 200000-line session-wide history limit must not return" >&2
  exit 1
fi

invalid_log="$TEST_ROOT/invalid.log"
if run_wrapper 99 "$invalid_log" >"$TEST_ROOT/invalid.out" 2>&1; then
  echo "Expected an invalid HUD history limit to fail" >&2
  exit 1
fi
if grep -q '^new-session ' "$invalid_log"; then
  echo "Invalid history limit must fail before creating a tmux session" >&2
  exit 1
fi

echo "test-hud-history-limit: PASS"
