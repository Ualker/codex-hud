#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
FAKE_TMUX_DIR="$SCRIPT_DIR/fake-tmux"
TEST_ROOT="$(mktemp -d /tmp/codex-hud-height-XXXXXX)"
FAKE_BIN_DIR="$TEST_ROOT/bin"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

mkdir -p "$FAKE_BIN_DIR"

cat > "$FAKE_BIN_DIR/codex" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE

cat > "$FAKE_BIN_DIR/node" <<'FAKE'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then
  echo "v20.19.0"
fi
exit 0
FAKE

cat > "$FAKE_BIN_DIR/npm" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE

cat > "$FAKE_BIN_DIR/tput" <<'FAKE'
#!/usr/bin/env bash
case "${1:-}" in
  lines) echo "${FAKE_TERM_LINES:-60}" ;;
  cols) echo "${FAKE_TERM_COLS:-120}" ;;
  *) echo "0" ;;
esac
FAKE

chmod +x "$FAKE_BIN_DIR/codex" "$FAKE_BIN_DIR/node" "$FAKE_BIN_DIR/npm" "$FAKE_BIN_DIR/tput"

run_case() {
  local label="$1"
  local expected_split="$2"
  local expected_resize="$3"
  local requested="$4"
  local term_lines="$5"
  local term_cols="$6"
  local auto_override="$7"
  local expected_auto="$8"
  local expected_adaptive="$9"
  local log_file="$TEST_ROOT/${label}.tmux.log"
  local output_file="$TEST_ROOT/${label}.wrapper.log"

  local -a wrapper_env=(
    "PATH=$FAKE_BIN_DIR:$FAKE_TMUX_DIR:$PATH"
    "HOME=$TEST_ROOT/home"
    "CODEX_HOME=$TEST_ROOT/codex-home"
    "FAKE_TERM_LINES=$term_lines"
    "FAKE_TERM_COLS=$term_cols"
    "TMUX_LOG_FILE=$log_file"
    "TMUX_MAIN_PANE_ID=%1"
    "TMUX_PANE_ID=%2"
    $'TMUX_PANES=%1\n%2'
    "TMUX_SPLIT_PANE_ID=%2"
    "TMUX_BASE_HEIGHT=$expected_split"
    "TMUX_HEIGHT=$expected_split"
    "TMUX_HEIGHT_MIN=5"
    "TMUX_HEIGHT_MAX=12"
    "TMUX_AUTO=$expected_auto"
    "TMUX_ADAPTIVE=$expected_adaptive"
    "TMUX_PANE_WIDTH=$term_cols"
    "TMUX_PANE_HEIGHT=1"
    "TMUX_WINDOW_HEIGHT=$term_lines"
    "TMUX_MAIN_PANE_IN_MODE=0"
  )

  if [[ -n "$requested" ]]; then
    wrapper_env+=("CODEX_HUD_HEIGHT=$requested")
  fi
  if [[ -n "$auto_override" ]]; then
    wrapper_env+=("CODEX_HUD_HEIGHT_AUTO=$auto_override")
  fi

  env -u CODEX_HUD_HEIGHT -u CODEX_HUD_HEIGHT_AUTO "${wrapper_env[@]}" \
    bash "$ROOT_DIR/bin/codex-hud" --new-session >"$output_file" 2>&1

  local split_line
  split_line="$(grep -m1 '^split-window ' "$log_file" || true)"
  if [[ "$split_line" != *" -l $expected_split "* ]]; then
    echo "Expected split-window height $expected_split for $label, log:" >&2
    cat "$log_file" >&2
    exit 1
  fi

  if ! grep -q "^resize=$expected_resize$" "$log_file"; then
    echo "Expected resize-pane height $expected_resize for $label, log:" >&2
    cat "$log_file" >&2
    exit 1
  fi
  if ! grep -q "^@codex_hud_auto=${expected_auto}$" "$log_file"; then
    echo "Expected adaptive-width setting $expected_auto for $label, log:" >&2
    cat "$log_file" >&2
    exit 1
  fi
  if ! grep -q "^@codex_hud_height_adaptive=${expected_adaptive}$" "$log_file"; then
    echo "Expected adaptive-height setting $expected_adaptive for $label, log:" >&2
    cat "$log_file" >&2
    exit 1
  fi
}

run_case default-24 5 5 "" 24 120 "" 1 1
run_case default-60 10 10 "" 60 120 "" 1 1
run_case default-120-capped 12 12 "" 120 120 "" 1 1
run_case default-narrow 10 12 "" 60 70 "" 1 1
run_case default-auto-disabled 10 10 "" 60 70 0 0 1
run_case explicit-fixed 7 7 7 60 50 "" 0 0
run_case explicit-auto 7 9 7 60 70 1 1 0

echo "test-default-hud-height: PASS (adaptive=5..12 explicit=7)"
