#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
FAKE_BIN_DIR="$TEST_ROOT/bin"
TMUX_DIR="$TEST_ROOT/tmux"
RESULT_FILE="$TEST_ROOT/capability-result"
WRAPPER_LOG="$TEST_ROOT/wrapper.log"
CAPABILITY_VALUE="capability-fixture-do-not-log"

cleanup() {
  env -u TMUX TMUX_TMPDIR="$TMUX_DIR" tmux kill-server >/dev/null 2>&1 || true
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

mkdir -p "$FAKE_BIN_DIR" "$TMUX_DIR"

cat > "$FAKE_BIN_DIR/codex" <<'FAKE'
#!/usr/bin/env bash
if [[ -z "${CMUX_SOCKET_CAPABILITY:-}" || -z "${CMUX_TEST_RESULT_FILE:-}" ]]; then
  exit 9
fi
session_capability="$(tmux show-environment -t "$TMUX_PANE" \
  CMUX_SOCKET_CAPABILITY 2>/dev/null || true)"
if [[ "$session_capability" != \
  "CMUX_SOCKET_CAPABILITY=$CMUX_SOCKET_CAPABILITY" ]]; then
  exit 10
fi
printf '%s' "$CMUX_SOCKET_CAPABILITY" > "$CMUX_TEST_RESULT_FILE"
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
  lines) echo "24" ;;
  cols) echo "100" ;;
  *) echo "0" ;;
esac
FAKE

chmod +x "$FAKE_BIN_DIR/codex" "$FAKE_BIN_DIR/node" \
  "$FAKE_BIN_DIR/npm" "$FAKE_BIN_DIR/tput"

while IFS= read -r name; do
  unset "$name"
done < <(env | sed -n 's/^\(CMUX_[A-Za-z0-9_]*\)=.*/\1/p' | LC_ALL=C sort -u)

export CMUX_TEST_RESULT_FILE="$RESULT_FILE"

# Start the isolated server with a stale value, then launch the HUD from a
# current cmux context. The new session must override the server-global value
# and retain it for event-time hook routing.
export CMUX_SOCKET_CAPABILITY="stale-capability-fixture"
env -u TMUX TMUX_TMPDIR="$TMUX_DIR" tmux -f /dev/null \
  new-session -d -s bootstrap "sleep 30"
export CMUX_SOCKET_CAPABILITY="$CAPABILITY_VALUE"

set +e
(cd "$ROOT_DIR" && env -u TMUX TMUX_TMPDIR="$TMUX_DIR" \
  PATH="$FAKE_BIN_DIR:$PATH" SHELL=/bin/sh \
  TMPDIR="$TEST_ROOT" \
  CODEX_HUD_HEIGHT=5 CODEX_HUD_HEIGHT_AUTO=0 \
  "$ROOT_DIR/bin/codex-hud" --new-session >"$WRAPPER_LOG" 2>&1)
status=$?
set -e

if [[ "$status" -eq 0 ]] || \
   ! grep -q 'open terminal failed: not a terminal' "$WRAPPER_LOG"; then
  echo "Expected the isolated non-TTY attach to fail after creating the session" >&2
  exit 1
fi
if grep -Fq "$CAPABILITY_VALUE" "$WRAPPER_LOG"; then
  echo "Capability value leaked into wrapper output" >&2
  exit 1
fi

hud_session="$(env -u TMUX TMUX_TMPDIR="$TMUX_DIR" \
  tmux list-sessions -F '#{session_name}' | grep '^codex-hud-' | tail -n1)"
if [[ -z "$hud_session" ]]; then
  echo "Expected an isolated HUD session" >&2
  exit 1
fi

session_capability="$(env -u TMUX TMUX_TMPDIR="$TMUX_DIR" \
  tmux show-environment -t "$hud_session" CMUX_SOCKET_CAPABILITY 2>/dev/null || true)"
if [[ "$session_capability" != \
  "CMUX_SOCKET_CAPABILITY=$CAPABILITY_VALUE" ]]; then
  echo "Current capability was not retained in the tmux session" >&2
  exit 1
fi

start_commands="$(env -u TMUX TMUX_TMPDIR="$TMUX_DIR" \
  tmux list-panes -t "$hud_session" -F '#{pane_start_command}')"
if [[ "$start_commands" == *"$CAPABILITY_VALUE"* ]]; then
  echo "Capability value leaked into a pane start command" >&2
  exit 1
fi

env -u TMUX TMUX_TMPDIR="$TMUX_DIR" \
  tmux set-option -t "$hud_session" -q @codex_hud_client_attached 1
for _ in $(seq 1 200); do
  [[ -s "$RESULT_FILE" ]] && break
  sleep 0.05
done
if [[ ! -s "$RESULT_FILE" ]]; then
  echo "Expected the Codex pane to inherit the current session capability" >&2
  exit 1
fi
if [[ "$(cat "$RESULT_FILE")" != "$CAPABILITY_VALUE" ]]; then
  echo "Codex pane received the wrong capability value" >&2
  exit 1
fi
echo "test-wrapper-cmux-capability-delivery: PASS"
