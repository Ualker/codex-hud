#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

FAKE_BIN_DIR="$(mktemp -d)"
TMUX_DIR="$(mktemp -d)"

cleanup() {
  env -u TMUX TMUX_TMPDIR="$TMUX_DIR" tmux kill-server >/dev/null 2>&1 || true
  rm -rf "$FAKE_BIN_DIR" "$TMUX_DIR"
}
trap cleanup EXIT

cat > "$FAKE_BIN_DIR/codex" <<'FAKE'
#!/usr/bin/env bash
echo fake-codex
exit 0
FAKE

cat > "$FAKE_BIN_DIR/node" <<'FAKE'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then
  echo "v20.0.0"
  exit 0
fi
exit 0
FAKE

cat > "$FAKE_BIN_DIR/npm" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE

cat > "$FAKE_BIN_DIR/tput" <<'FAKE'
#!/usr/bin/env bash
if [[ "${1:-}" == "lines" ]]; then
  echo "24"
  exit 0
fi
if [[ "${1:-}" == "cols" ]]; then
  echo "80"
  exit 0
fi
echo "0"
FAKE

chmod +x "$FAKE_BIN_DIR/codex" "$FAKE_BIN_DIR/node" "$FAKE_BIN_DIR/npm" "$FAKE_BIN_DIR/tput"

# Keep the fixture independent from a real cmux session running the tests.
while IFS= read -r name; do
  unset "$name"
done < <(env | sed -n 's/^\(CMUX_[A-Za-z0-9_]*\)=.*/\1/p' | LC_ALL=C sort -u)

env -u TMUX TMUX_TMPDIR="$TMUX_DIR" tmux -f /dev/null new-session -d -s bootstrap "sleep 30"
env -u TMUX TMUX_TMPDIR="$TMUX_DIR" tmux -f /dev/null set-option -g base-index 1

set +e
output=$(env -u TMUX TMUX_TMPDIR="$TMUX_DIR" PATH="$FAKE_BIN_DIR:$PATH" CODEX_HUD_HEIGHT=5 CODEX_HUD_HEIGHT_AUTO=0 "$ROOT_DIR/bin/codex-hud" 2>&1)
status=$?
set -e

if grep -q "no such window" <<<"$output"; then
  echo "Unexpected no such window error:" >&2
  echo "$output" >&2
  exit 1
fi

# Non-interactive shell cannot attach tmux client; this is expected here.
if ! grep -q "open terminal failed: not a terminal" <<<"$output"; then
  echo "Expected non-interactive attach error was not observed:" >&2
  echo "$output" >&2
  exit 1
fi

if [[ "$status" -eq 0 ]]; then
  echo "Expected non-zero exit in non-interactive shell" >&2
  exit 1
fi

# The failed non-interactive attach leaves the isolated HUD session running.
# Open its launch gate manually, then prove the real tmux pane does not contain
# the injected launch command and becomes an interactive shell after Codex exits.
hud_session=$(env -u TMUX TMUX_TMPDIR="$TMUX_DIR" tmux list-sessions -F '#{session_name}' \
  | grep '^codex-hud-' | tail -n1 || true)
if [[ -z "$hud_session" ]]; then
  echo "Expected the isolated HUD session to survive the failed attach" >&2
  exit 1
fi

main_pane=$(env -u TMUX TMUX_TMPDIR="$TMUX_DIR" tmux show-option -t "$hud_session" -qv @codex_hud_main_pane)
if [[ -z "$main_pane" ]]; then
  echo "Expected the isolated HUD session to record its main pane" >&2
  exit 1
fi

env -u TMUX TMUX_TMPDIR="$TMUX_DIR" tmux set-option -t "$hud_session" -q @codex_hud_client_attached 1

pane_output=""
for _ in $(seq 1 100); do
  pane_output=$(env -u TMUX TMUX_TMPDIR="$TMUX_DIR" tmux capture-pane -p -t "$main_pane" -S - 2>/dev/null || true)
  if grep -q 'fake-codex' <<<"$pane_output"; then
    break
  fi
  sleep 0.05
done

if ! grep -q 'fake-codex' <<<"$pane_output"; then
  echo "Expected the gated Codex command to run after the client gate opened" >&2
  echo "$pane_output" >&2
  exit 1
fi
if grep -q '@codex_hud_client_attached' <<<"$pane_output"; then
  echo "Codex launch command was echoed into the real tmux pane" >&2
  echo "$pane_output" >&2
  exit 1
fi

shell_marker="$TMUX_DIR/shell-ready"
shell_marker_escaped=$(printf '%q' "$shell_marker")
env -u TMUX TMUX_TMPDIR="$TMUX_DIR" tmux send-keys -t "$main_pane" "touch $shell_marker_escaped" C-m
for _ in $(seq 1 100); do
  [[ -e "$shell_marker" ]] && break
  sleep 0.05
done
if [[ ! -e "$shell_marker" ]]; then
  echo "Expected an interactive shell after fake Codex exited" >&2
  exit 1
fi
if ! env -u TMUX TMUX_TMPDIR="$TMUX_DIR" tmux has-session -t "$hud_session" 2>/dev/null; then
  echo "Expected the HUD session to remain reconnectable after Codex exited" >&2
  exit 1
fi

echo "test-wrapper-base-index-smoke: PASS"
