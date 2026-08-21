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
    # The -a form is the session list's bulk query; the -t form is the
    # pane-pid resolve the staleness marker walks. Two shapes, one stub.
    # (No backquotes here: this heredoc is unquoted.)
    if [[ "\$*" == *"-t"* ]]; then
      if [[ -n "\${STUB_PANE_PIDS:-}" ]]; then
        printf '%s\n' "\$STUB_PANE_PIDS"
      fi
    elif [[ -n "\${STUB_PANES:-}" ]]; then
      printf '%s\n' "\$STUB_PANES"
    fi
    ;;
esac
exit 0
FAKE
chmod +x "$FAKE_BIN_DIR/tmux"

# The staleness probe compares the HUD process age against dist mtime; both
# sides are stubbed through ps (the full-table walk and the etime query).
cat > "$FAKE_BIN_DIR/ps" <<FAKE
#!/usr/bin/env bash
case "\${1:-}" in
  -axo)
    if [[ -n "\${STUB_PS_TABLE:-}" ]]; then
      printf '%s\n' "\$STUB_PS_TABLE"
    fi
    ;;
  -p)
    if [[ -n "\${STUB_ETIME:-}" ]]; then
      printf '%s\n' "\$STUB_ETIME"
    fi
    ;;
esac
exit 0
FAKE
chmod +x "$FAKE_BIN_DIR/ps"

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

# A live HUD pane whose process predates dist/index.js is running a stale
# build — the exact question asked after every rebuild. The probe walks the
# pane's process tree for the HUD entrypoint and compares its age with the
# build's mtime; five days of elapsed time is unambiguously older than a
# dist built by this test run.
session_row="codex-hud-prj-2a51592d-20260812135511-57225|%1|%2|attached"
panes_live="%1|live|$TEST_HOME/Desktop/prj
%2|live|$TEST_HOME/Desktop/prj"
pane_pids="%1 4100
%2 4200"
ps_table="4200 1 node node $ROOT_DIR/dist/index.js"

if [[ -f "$ROOT_DIR/dist/index.js" ]]; then
  out="$(STUB_PANE_PIDS="$pane_pids" STUB_PS_TABLE="$ps_table" STUB_ETIME="05-00:00:00"     run_list "$session_row" "$panes_live")"
  assert_contains "$out" "HUD: outdated (codex-hud --reload)"     "a HUD older than the build on disk is marked stale"

  out="$(STUB_PANE_PIDS="$pane_pids" STUB_PS_TABLE="$ps_table" STUB_ETIME="0:01"     run_list "$session_row" "$panes_live")"
  assert_missing "$out" "HUD: outdated"     "a HUD younger than the build is not marked"
else
  echo "SKIP: dist/index.js missing; staleness marker cases need a build" >&2
fi

# A probe that cannot resolve the HUD process stays silent: unmarked means
# "not known stale", never "verified fresh".
out="$(run_list "$session_row" "$panes_live")"
assert_missing "$out" "HUD: outdated" "an unresolvable probe never marks"

echo "test-list-sessions: PASS"
