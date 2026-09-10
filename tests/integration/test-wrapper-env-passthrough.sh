#!/usr/bin/env bash
# tmux panes inherit the tmux server's environment, not the launching shell's,
# so every variable the HUD renderer consumes must be baked into the pane
# command. Verified live before the fix: with the tmux server running since
# the previous day, an exported CODEX_HUD_NOTIFY_CMD never reached the HUD
# process. This proves the bake round-trips tricky values (quotes, spaces) on
# session creation, and that --reload re-bakes the caller's *current*
# environment instead of reviving the values frozen at creation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
FAKE_TMUX_DIR="$SCRIPT_DIR/fake-tmux"
FAKE_BIN_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$FAKE_BIN_DIR"
}
trap cleanup EXIT

cat > "$FAKE_BIN_DIR/codex" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE

# The pane command execs `env ... node dist/index.js`; this stub receives that
# exec and prints the variables under test, proving the values survive the
# quoting round trip exactly.
cat > "$FAKE_BIN_DIR/node" <<'FAKE'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then
  echo "v20.19.0"
  exit 0
fi
if [[ "${1:-}" == "-e" ]]; then
  exit 0
fi
printf 'NOTIFY<%s>\n' "${CODEX_HUD_NOTIFY_CMD:-}"
printf 'DENSITY<%s>\n' "${CODEX_HUD_DETAILS:-}"
printf 'DETAILS<%s>\n' "${CODEX_HUD_TOOL_DETAILS:-}"
printf 'NOCOLOR<%s>\n' "${NO_COLOR:-}"
printf 'LOGFILE<%s>\n' "${CODEX_HUD_LOG_FILE:-}"
exit 0
FAKE

cat > "$FAKE_BIN_DIR/npm" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE

cat > "$FAKE_BIN_DIR/tput" <<'FAKE'
#!/usr/bin/env bash
if [[ "${1:-}" == "lines" ]]; then echo "24"; exit 0; fi
if [[ "${1:-}" == "cols" ]]; then echo "80"; exit 0; fi
echo "0"
FAKE

chmod +x "$FAKE_BIN_DIR/codex" "$FAKE_BIN_DIR/node" "$FAKE_BIN_DIR/npm" "$FAKE_BIN_DIR/tput"

export PATH="$FAKE_BIN_DIR:$FAKE_TMUX_DIR:$PATH"
export CODEX_HUD_HEIGHT="5"
export CODEX_HUD_HEIGHT_AUTO="0"
unset TMUX

log_file="$(mktemp)"
export TMUX_LOG_FILE="$log_file"
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
export TMUX_WINDOW_HEIGHT="24"

# The value every naive interpolation breaks on: a single quote, double
# quotes, spaces, and a $ that must stay literal until the notify hook runs.
TRICKY_CMD='osascript -e "display notification \"it'\''s done: $CODEX_HUD_EVENT\""'

failures=0
fail() {
  echo "  FAIL: $1" >&2
  failures=$((failures + 1))
}

run_pane_command() {
  # Re-execute the logged pane command the way tmux would; the node stub
  # prints the environment it received.
  local line="$1"
  local pane_cmd="${line#* -P -F #\{pane_id\} }"
  if [[ "$pane_cmd" == "$line" ]]; then
    echo "could not extract pane command from: $line" >&2
    return 1
  fi
  bash -c "$pane_cmd"
}

echo "session creation bakes the caller's environment:"
: > "$log_file"
env \
  CODEX_HUD_NOTIFY_CMD="$TRICKY_CMD" \
  CODEX_HUD_TOOL_DETAILS="full" \
  CODEX_HUD_DETAILS="full" \
  NO_COLOR="1" \
  "$ROOT_DIR/bin/codex-hud" >/dev/null 2>&1 || true

split_line="$(grep '^split-window ' "$log_file" | head -n1 || true)"
if [[ -z "$split_line" ]]; then
  fail "no split-window recorded"
else
  out="$(run_pane_command "$split_line" || true)"
  [[ "$out" == *"NOTIFY<$TRICKY_CMD>"* ]] \
    || fail "NOTIFY_CMD did not round-trip: $out"
  [[ "$out" == *'DENSITY<full>'* ]] || fail "HUD density not baked: $out"
  [[ "$out" == *'DETAILS<full>'* ]] || fail "TOOL_DETAILS not baked: $out"
  [[ "$out" == *'NOCOLOR<1>'* ]] || fail "NO_COLOR not baked: $out"
  # Unset in the launching shell means absent from the command: the pane must
  # not inherit a stale value baked as an empty string.
  [[ "$out" == *'LOGFILE<>'* ]] || fail "unset LOG_FILE leaked a value: $out"
  [[ "$split_line" != *'CODEX_HUD_LOG_FILE='* ]] \
    || fail "unset LOG_FILE appears in the pane command"
fi

# The prefix computation mirrors the wrapper's session naming so --reload
# finds "an existing session for this directory".
slug="$(basename "$PWD" | LC_ALL=C tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g; s/^-+//; s/-+$//')"
slug="${slug:0:32}"
if command -v md5sum >/dev/null 2>&1; then
  hash="$(printf "%s" "$PWD" | md5sum | awk '{print $1}')"
else
  hash="$(printf "%s" "$PWD" | md5 -q)"
fi
export TMUX_SESSION_LIST="codex-hud-${slug}-${hash:0:8}-20260821000000-1"

echo "--reload re-bakes the current environment:"
: > "$log_file"
export TMUX_STORED_CWD="$PWD"
export TMUX_STORED_SESSION_START="1787280000"
env \
  CODEX_HUD_NOTIFY_CMD="tmux display-message updated" \
  "$ROOT_DIR/bin/codex-hud" --reload >/dev/null 2>&1 || true

respawn_line="$(grep '^respawn-pane ' "$log_file" | head -n1 || true)"
if [[ -z "$respawn_line" ]]; then
  fail "no respawn-pane recorded for --reload"
else
  pane_cmd="${respawn_line#respawn-pane -k -t %2 }"
  if [[ "$pane_cmd" == "$respawn_line" || -z "$pane_cmd" ]]; then
    fail "--reload did not rebuild the pane command: $respawn_line"
  else
    out="$(bash -c "$pane_cmd" || true)"
    [[ "$out" == *'NOTIFY<tmux display-message updated>'* ]] \
      || fail "--reload kept a stale NOTIFY_CMD: $out"
    [[ "$out" == *'DENSITY<>'* ]] || fail "reload retained a stale HUD density: $out"
    [[ "$out" == *'DETAILS<>'* ]] \
      || fail "--reload carried a value the caller no longer sets: $out"
  fi
fi

echo "sessions from older wrappers keep their original command:"
: > "$log_file"
unset TMUX_STORED_CWD TMUX_STORED_SESSION_START
"$ROOT_DIR/bin/codex-hud" --reload >/dev/null 2>&1 || true
legacy_line="$(grep '^respawn-pane ' "$log_file" | head -n1 || true)"
if [[ "$legacy_line" != "respawn-pane -k -t %2" ]]; then
  fail "legacy session should respawn without a command: $legacy_line"
fi

if [[ "$failures" -gt 0 ]]; then
  echo "test-wrapper-env-passthrough: FAIL ($failures)"
  exit 1
fi
echo "test-wrapper-env-passthrough: PASS"
