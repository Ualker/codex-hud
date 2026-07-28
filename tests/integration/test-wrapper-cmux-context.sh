#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
FAKE_TMUX_DIR="$SCRIPT_DIR/fake-tmux"
TEST_TMP_DIR="$(mktemp -d)"
FAKE_BIN_DIR="$TEST_TMP_DIR/bin"
TMUX_LOG_FILE="$TEST_TMP_DIR/tmux.log"

cleanup() {
  rm -rf "$TEST_TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$FAKE_BIN_DIR"

cat > "$FAKE_BIN_DIR/codex" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE

cat > "$FAKE_BIN_DIR/cmux-codex-shim" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE

cat > "$FAKE_BIN_DIR/node" <<'FAKE'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then
  echo "v20.0.0"
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
  lines) echo "24" ;;
  cols) echo "80" ;;
  *) echo "0" ;;
esac
FAKE

chmod +x \
  "$FAKE_BIN_DIR/codex" \
  "$FAKE_BIN_DIR/cmux-codex-shim" \
  "$FAKE_BIN_DIR/node" \
  "$FAKE_BIN_DIR/npm" \
  "$FAKE_BIN_DIR/tput"

# Keep the fixture independent from any real cmux session running the tests.
while IFS= read -r name; do
  unset "$name"
done < <(env | sed -n 's/^\(CMUX_[A-Za-z0-9_]*\)=.*/\1/p' | LC_ALL=C sort -u)

export PATH="$FAKE_BIN_DIR:$FAKE_TMUX_DIR:$PATH"
export TMUX_LOG_FILE
export TMUX_MAIN_PANE_ID="%1"
export TMUX_PANE_ID="%2"
export TMUX_PANES=$'%1\n%2'
export TMUX_SPLIT_PANE_ID="%2"
export TMUX_PANE_WIDTH="120"
export TMUX_PANE_HEIGHT="5"
export TMUX_SUPPORTS_NEW_SESSION_ENV="1"
export CODEX_HUD_HEIGHT="5"
export CODEX_HUD_HEIGHT_AUTO="0"

export CMUX_WORKSPACE_ID="workspace-current"
export CMUX_SURFACE_ID="surface-current"
export CMUX_SOCKET_PATH="$TEST_TMP_DIR/cmux.sock"
export CMUX_SOCKET_CAPABILITY="capability-current"
export CMUX_CODEX_WRAPPER_SHIM="$FAKE_BIN_DIR/cmux-codex-shim"
export CMUX_CODEX_PID="stale-codex-pid"
export CMUX_CODEX_HOOK_CMUX_BIN="/tmp/stale-cmux"
export CMUX_AGENT_LAUNCH_KIND="stale-launch-kind"

"$ROOT_DIR/bin/codex-hud" --new-session >"$TEST_TMP_DIR/wrapper.log" 2>&1

new_session_line=$(grep '^new-session ' "$TMUX_LOG_FILE")
launch_line=$(grep '^respawn-pane .*@codex_hud_client_attached' "$TMUX_LOG_FILE")

for expected in \
  "CMUX_WORKSPACE_ID=workspace-current" \
  "CMUX_SURFACE_ID=surface-current" \
  "CMUX_SOCKET_PATH=$TEST_TMP_DIR/cmux.sock" \
  "CMUX_SOCKET_CAPABILITY=capability-current" \
  "CMUX_CODEX_WRAPPER_SHIM=$FAKE_BIN_DIR/cmux-codex-shim"; do
  if [[ "$new_session_line" != *"-e $expected"* ]]; then
    echo "expected new tmux session to include: $expected" >&2
    cat "$TMUX_LOG_FILE" >&2
    exit 1
  fi
done

for excluded in CMUX_CODEX_PID CMUX_CODEX_HOOK_CMUX_BIN CMUX_AGENT_LAUNCH_KIND; do
  if [[ "$new_session_line" == *"$excluded="* ]]; then
    echo "expected new tmux session to exclude transient variable: $excluded" >&2
    cat "$TMUX_LOG_FILE" >&2
    exit 1
  fi
done

if grep -q '^send-keys .*@codex_hud_client_attached' "$TMUX_LOG_FILE"; then
  echo "expected Codex launch not to be injected with send-keys" >&2
  cat "$TMUX_LOG_FILE" >&2
  exit 1
fi

if [[ "$launch_line" != *"$FAKE_BIN_DIR/cmux-codex-shim"* ]]; then
  echo "expected Codex launch to use CMUX_CODEX_WRAPPER_SHIM" >&2
  cat "$TMUX_LOG_FILE" >&2
  exit 1
fi

if [[ "$launch_line" == *"capability-current"* ]]; then
  echo "expected socket capability to stay out of the pane command" >&2
  cat "$TMUX_LOG_FILE" >&2
  exit 1
fi

# tmux before 3.2 has no new-session -e. Verify the scoped fallback updates
# only the new session, respawns its untouched shell, then launches Codex.
: > "$TMUX_LOG_FILE"
export TMUX_SUPPORTS_NEW_SESSION_ENV="0"
"$ROOT_DIR/bin/codex-hud" --new-session >"$TEST_TMP_DIR/wrapper-legacy-tmux.log" 2>&1

new_session_line=$(grep '^new-session ' "$TMUX_LOG_FILE")
launch_line=$(grep '^respawn-pane .*@codex_hud_client_attached' "$TMUX_LOG_FILE")

if [[ "$new_session_line" == *"-e CMUX_"* ]]; then
  echo "expected legacy tmux fallback not to use new-session -e" >&2
  cat "$TMUX_LOG_FILE" >&2
  exit 1
fi

for expected in \
  "CMUX_WORKSPACE_ID workspace-current" \
  "CMUX_SURFACE_ID surface-current" \
  "CMUX_SOCKET_PATH $TEST_TMP_DIR/cmux.sock" \
  "CMUX_SOCKET_CAPABILITY capability-current" \
  "CMUX_CODEX_WRAPPER_SHIM $FAKE_BIN_DIR/cmux-codex-shim"; do
  if ! grep -Fq "set-environment -t " "$TMUX_LOG_FILE" || \
     ! grep -Fq "$expected" "$TMUX_LOG_FILE"; then
    echo "expected legacy tmux fallback to set: $expected" >&2
    cat "$TMUX_LOG_FILE" >&2
    exit 1
  fi
done

for excluded in CMUX_CODEX_PID CMUX_CODEX_HOOK_CMUX_BIN CMUX_AGENT_LAUNCH_KIND; do
  if grep -Fq "set-environment -t " "$TMUX_LOG_FILE" && grep -Fq "$excluded" "$TMUX_LOG_FILE"; then
    echo "expected legacy tmux fallback to exclude transient variable: $excluded" >&2
    cat "$TMUX_LOG_FILE" >&2
    exit 1
  fi
done

set_env_line_number=$(grep -n '^set-environment ' "$TMUX_LOG_FILE" | tail -n1 | cut -d: -f1)
respawn_line_number=$(grep -n '^respawn-pane -k -t %1$' "$TMUX_LOG_FILE" | cut -d: -f1)
launch_line_number=$(grep -n '^respawn-pane .*@codex_hud_client_attached' "$TMUX_LOG_FILE" | cut -d: -f1)
if (( set_env_line_number >= respawn_line_number || respawn_line_number >= launch_line_number )); then
  echo "expected legacy tmux environment, respawn, and Codex launch in that order" >&2
  cat "$TMUX_LOG_FILE" >&2
  exit 1
fi

if grep -q '^send-keys .*@codex_hud_client_attached' "$TMUX_LOG_FILE"; then
  echo "expected legacy Codex launch not to be injected with send-keys" >&2
  cat "$TMUX_LOG_FILE" >&2
  exit 1
fi

if [[ "$launch_line" != *"$FAKE_BIN_DIR/cmux-codex-shim"* || \
      "$launch_line" == *"capability-current"* ]]; then
  echo "expected legacy tmux launch to use the cmux shim without exposing capability" >&2
  cat "$TMUX_LOG_FILE" >&2
  exit 1
fi

echo "test-wrapper-cmux-context: PASS"
