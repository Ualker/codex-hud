#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
FAKE_TMUX_DIR="$SCRIPT_DIR/fake-tmux"
TEST_TMP_DIR="$(mktemp -d)"
FAKE_BIN_DIR="$TEST_TMP_DIR/codex dir;\$(marker)"
FAKE_SHELL_DIR="$TEST_TMP_DIR/shell dir;\$(marker)"
FAKE_SHELL_PATH="$FAKE_SHELL_DIR/user shell"
LOG_FILE="$TEST_TMP_DIR/tmux.log"
OUTPUT_FILE="$TEST_TMP_DIR/wrapper.log"
CODEX_MARKER_FILE="$TEST_TMP_DIR/codex-ran"
SHELL_MARKER_FILE="$TEST_TMP_DIR/shell-resumed"
INJECTION_MARKER_FILE="$TEST_TMP_DIR/command-substitution-ran"

cleanup() {
  rm -rf "$TEST_TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "test-wrapper-command-visibility: FAIL - $1" >&2
  [[ -f "$LOG_FILE" ]] && { echo "--- tmux log ---" >&2; cat "$LOG_FILE" >&2; }
  [[ -f "$OUTPUT_FILE" ]] && { echo "--- wrapper output ---" >&2; cat "$OUTPUT_FILE" >&2; }
  exit 1
}

mkdir -p "$FAKE_BIN_DIR" "$FAKE_SHELL_DIR"

cat > "$FAKE_BIN_DIR/codex" <<'FAKE'
#!/usr/bin/env bash
printf 'codex\n' > "${CODEX_MARKER_FILE:?}"
exit 7
FAKE

cat > "$FAKE_SHELL_PATH" <<'FAKE'
#!/usr/bin/env bash
printf 'shell\n' > "${SHELL_MARKER_FILE:?}"
exit 0
FAKE

cat > "$FAKE_BIN_DIR/marker" <<'FAKE'
#!/usr/bin/env bash
printf 'injected\n' > "${INJECTION_MARKER_FILE:?}"
FAKE

cat > "$FAKE_BIN_DIR/node" <<'FAKE'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then
  echo "v20.11.0"
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
  lines) echo 24 ;;
  cols) echo 80 ;;
  *) echo 0 ;;
esac
FAKE

chmod +x \
  "$FAKE_BIN_DIR/codex" \
  "$FAKE_BIN_DIR/marker" \
  "$FAKE_BIN_DIR/node" \
  "$FAKE_BIN_DIR/npm" \
  "$FAKE_BIN_DIR/tput" \
  "$FAKE_SHELL_PATH"

# Keep the fixture independent from a real cmux session running the tests.
while IFS= read -r name; do
  unset "$name"
done < <(env | sed -n 's/^\(CMUX_[A-Za-z0-9_]*\)=.*/\1/p' | LC_ALL=C sort -u)

export PATH="$FAKE_BIN_DIR:$FAKE_TMUX_DIR:$PATH"
export SHELL="$FAKE_SHELL_PATH"
export CODEX_MARKER_FILE
export SHELL_MARKER_FILE
export INJECTION_MARKER_FILE
export CODEX_HUD_HEIGHT="5"
export CODEX_HUD_HEIGHT_AUTO="0"
export TMUX_LOG_FILE="$LOG_FILE"
export TMUX_MAIN_PANE_ID="%1"
export TMUX_PANE_ID="%2"
export TMUX_PANES=$'%1\n%2'
export TMUX_SPLIT_PANE_ID="%2"
export TMUX_BASE_HEIGHT="5"
export TMUX_HEIGHT="5"
export TMUX_HEIGHT_MIN="5"
export TMUX_HEIGHT_MAX="12"
export TMUX_AUTO="0"
export TMUX_PANE_WIDTH="120"
export TMUX_PANE_HEIGHT="5"

"$ROOT_DIR/bin/codex-hud" --new-session >"$OUTPUT_FILE" 2>&1

if grep -q '^send-keys .*@codex_hud_client_attached' "$LOG_FILE"; then
  fail "Codex launch is still injected into the interactive shell with send-keys"
fi

launch_line="$(grep -m1 '^respawn-pane .*@codex_hud_client_attached' "$LOG_FILE" || true)"
if [[ -z "$launch_line" ]]; then
  fail "expected a direct respawn-pane launch command"
fi

for required in '@codex_hud_client_attached' 'cd ' 'codex' 'exec '; do
  if [[ "$launch_line" != *"$required"* ]]; then
    fail "respawn-pane launch is missing required component: $required"
  fi
done

if [[ "$launch_line" == *"tmux kill-session"* ]]; then
  fail "Codex launch must return to a shell instead of killing the tmux session"
fi

escaped_codex_path="$(printf '%q' "$FAKE_BIN_DIR/codex")"
escaped_shell_path="$(printf '%q' "$FAKE_SHELL_PATH")"
if [[ "$launch_line" != *"$escaped_codex_path"* ]]; then
  fail "Codex executable path is not shell-quoted in the respawn command"
fi
if [[ "$launch_line" != *"$escaped_shell_path"* ]]; then
  fail "resume shell path is not shell-quoted in the respawn command"
fi
if [[ "$launch_line" == *"$FAKE_BIN_DIR/codex"* || "$launch_line" == *"$FAKE_SHELL_PATH"* ]]; then
  fail "raw metacharacter path leaked into the respawn command"
fi

# Execute the emitted pane command with the gate already open. The fake Codex
# exits non-zero; the command must still replace its dispatcher with the user's
# shell, and shell metacharacters in either executable path must remain inert.
runtime_cmd="${launch_line#respawn-pane -k -t %1 }"
TMUX_SHOW_OPTION_DEFAULT="1" bash -c "$runtime_cmd"

if [[ "$(cat "$CODEX_MARKER_FILE" 2>/dev/null || true)" != "codex" ]]; then
  fail "emitted pane command did not run Codex"
fi
if [[ "$(cat "$SHELL_MARKER_FILE" 2>/dev/null || true)" != "shell" ]]; then
  fail "emitted pane command did not resume the user shell after Codex exited"
fi
if [[ -e "$INJECTION_MARKER_FILE" ]]; then
  fail "shell metacharacters from an executable path were evaluated"
fi

echo "test-wrapper-command-visibility: PASS"
