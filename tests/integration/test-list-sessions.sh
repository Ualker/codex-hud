#!/usr/bin/env bash
# `codex-hud --list` used to be `tmux ls | grep`, so with several sessions open
# in one project the output differed only by timestamp and pid — nothing about
# where each session is working or whether its HUD is still running. This
# exercises the parsing against a stub tmux, including the branches a live
# server rarely produces on demand (a dead HUD pane, a missing pane id).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
FAKE_BIN_DIR="$(mktemp -d)"
TEST_HOME="$(mktemp -d)"

cleanup() {
  rm -rf "$FAKE_BIN_DIR" "$TEST_HOME"
}
trap cleanup EXIT

cat > "$FAKE_BIN_DIR/tmux" <<FAKE
#!/usr/bin/env bash
cmd="\${1:-}"
shift || true
case "\$cmd" in
  -V)
    echo "tmux 3.4"
    ;;
  list-sessions)
    if [[ -n "\${STUB_SESSIONS:-}" ]]; then
      printf '%s\n' "\$STUB_SESSIONS"
    fi
    ;;
  list-panes)
    if [[ -n "\${STUB_PANES:-}" ]]; then
      printf '%s\n' "\$STUB_PANES"
    fi
    ;;
esac
exit 0
FAKE
chmod +x "$FAKE_BIN_DIR/tmux"

export PATH="$FAKE_BIN_DIR:$PATH"
export HOME="$TEST_HOME"

run_list() {
  STUB_SESSIONS="$1" STUB_PANES="$2" "$ROOT_DIR/bin/codex-hud" --list
}

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "FAIL: $label" >&2
    echo "expected to contain: $needle" >&2
    echo "actual output:" >&2
    printf '%s\n' "$haystack" >&2
    exit 1
  fi
}

assert_missing() {
  local haystack="$1" needle="$2" label="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "FAIL: $label" >&2
    echo "expected NOT to contain: $needle" >&2
    printf '%s\n' "$haystack" >&2
    exit 1
  fi
}

# No server, or no codex-hud sessions on it.
out="$(run_list "" "")"
assert_contains "$out" "(none)" "an empty server says so"

# Two sessions in different directories, one detached, plus an unrelated tmux
# session that must not be listed.
sessions="codex-hud-prj-2a51592d-20260812135511-57225|%1|%2|attached
codex-hud-api-9f3c1a20-20260812151832-33905|%3|%4|detached
work|%9|%9|attached"
panes="%1|live|$TEST_HOME/Desktop/prj
%2|live|$TEST_HOME/Desktop/prj
%3|live|/srv/api
%4|live|/srv/api"

out="$(run_list "$sessions" "$panes")"
assert_contains "$out" "codex-hud-prj-2a51592d-20260812135511-57225  ~/Desktop/prj  [attached]" \
  "the working directory and attach state travel with the name"
assert_contains "$out" "codex-hud-api-9f3c1a20-20260812151832-33905  /srv/api  [detached]" \
  "a path outside HOME is left absolute"
assert_missing "$out" "work" "sessions that are not codex-hud stay out"

# A HUD pane that exited leaves a dead pane behind (remain-on-exit). That is
# exactly the state where the pane looks frozen and the fix is one command.
panes_dead="%1|live|$TEST_HOME/Desktop/prj
%2|dead|$TEST_HOME/Desktop/prj"
out="$(run_list "codex-hud-prj-2a51592d-20260812135511-57225|%1|%2|attached" "$panes_dead")"
assert_contains "$out" "HUD: dead (codex-hud --reload)" "a dead HUD pane is named, with the fix"

# A working directory containing the field separator must survive intact: the
# path is the last field, so it is taken as the remainder, not as field three.
out="$(run_list "codex-hud-prj-2a51592d-20260812135511-57225|%1|%2|attached" \
  "%1|live|/srv/a|b/project
%2|live|/srv/a|b/project")"
assert_contains "$out" "/srv/a|b/project  [attached]" "a pipe in the path is not a split point"

# A session whose options were never set (an older build, or a hand-made
# session) still lists rather than breaking the loop.
out="$(run_list "codex-hud-prj-2a51592d-20260812135511-57225|||attached" "")"
assert_contains "$out" "codex-hud-prj-2a51592d-20260812135511-57225  ?  [attached]" \
  "an unknown directory is marked, not guessed"
assert_contains "$out" "HUD: missing" "and an unknown HUD pane is reported as such"

echo "test-list-sessions: PASS"
