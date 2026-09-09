#!/usr/bin/env bash
# `--kill` killed every session for the current directory while its help text
# said "Kill existing session" in the singular, with no confirmation and no
# names in the output. With two sessions open in one project — the common case
# this project is built around — there was no way to retire the old one
# without taking down the one being used. The default scope is now the newest
# session, matching --reload, and --all restores the wide scope explicitly.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
FAKE_BIN_DIR="$(mktemp -d)"
TEST_HOME="$(mktemp -d)"
WORK_DIR="$TEST_HOME/Desktop/prj"
KILL_LOG="$TEST_HOME/killed.log"

cleanup() {
  rm -rf "$FAKE_BIN_DIR" "$TEST_HOME"
}
trap cleanup EXIT

mkdir -p "$WORK_DIR"

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
  display-message)
    printf '%s\n' "\${STUB_CURRENT:-}"
    ;;
  kill-session)
    # -t <name>
    printf '%s\n' "\$2" >> "$KILL_LOG"
    ;;
esac
exit 0
FAKE
chmod +x "$FAKE_BIN_DIR/tmux"

export PATH="$FAKE_BIN_DIR:$PATH"
export HOME="$TEST_HOME"

cd "$WORK_DIR"

# The wrapper derives its session prefix from the working directory, so the
# fixture names must be built the same way hash_cwd() does.
if command -v md5sum >/dev/null 2>&1; then
  cwd_hash=$(printf "%s" "$WORK_DIR" | md5sum | awk '{print $1}')
else
  cwd_hash=$(printf "%s" "$WORK_DIR" | md5 -q)
fi
prefix="codex-hud-prj-${cwd_hash:0:8}"

OLD="${prefix}-20260818090000-11111"
NEW="${prefix}-20260819120000-22222"
OTHER="codex-hud-api-deadbeef-20260819120000-33333"
SESSIONS="$OLD
$NEW
$OTHER
work"

run_kill() {
  : > "$KILL_LOG"
  STUB_SESSIONS="$SESSIONS" "$ROOT_DIR/bin/codex-hud" "$@"
}

assert_killed() {
  local expected="$1" label="$2"
  local actual
  actual="$(sort "$KILL_LOG" | tr '\n' ' ' | sed 's/ $//')"
  local want
  want="$(printf '%s\n' $expected | sort | tr '\n' ' ' | sed 's/ $//')"
  if [[ "$actual" != "$want" ]]; then
    echo "FAIL: $label" >&2
    echo "  expected killed: $want" >&2
    echo "  actually killed: $actual" >&2
    exit 1
  fi
}

# External ambiguous selection must fail before killing anything.
if out="$(run_kill --kill 2>&1)"; then
  echo "FAIL: ambiguous directory must require --target" >&2
  exit 1
fi
assert_killed "" "ambiguous selection kills nothing"
[[ "$out" == *"--target"* && "$out" == *"$OLD"* && "$out" == *"$NEW"* ]]

# Inside tmux the current pane wins even when another session is newer.
out="$(TMUX=isolated-fixture TMUX_PANE=%1 STUB_CURRENT="$OLD" run_kill --kill)"
assert_killed "$OLD" "--kill selects the current pane's session"
[[ "$out" == *"$OLD"* ]]

out="$(run_kill --kill --target "$NEW")"
assert_killed "$NEW" "explicit session selection"
out="$(STUB_CURRENT="$OLD" run_kill --kill --target %1)"
assert_killed "$OLD" "explicit pane selection"
if out="$(run_kill --kill --target missing 2>&1)"; then exit 1; fi
assert_killed "" "invalid target does not fall back"
if out="$(run_kill --kill --all --target "$OLD" 2>&1)"; then exit 1; fi
assert_killed "" "conflicting flags do not mutate"

: > "$KILL_LOG"
STUB_SESSIONS="$OLD" "$ROOT_DIR/bin/codex-hud" --kill >/dev/null
assert_killed "$OLD" "an external unique candidate is selected"

# Explicit wide scope: every session for this directory, and nothing else.
out="$(run_kill --kill --all)"
assert_killed "$OLD $NEW" "--kill --all takes every session for this directory"
if [[ "$out" == *"$OTHER"* ]]; then
  echo "FAIL: another project's session must never be killed" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi

# Nothing to kill is a warning, not a failure, and kills nothing.
: > "$KILL_LOG"
out="$(STUB_SESSIONS="work" "$ROOT_DIR/bin/codex-hud" --kill 2>&1 || true)"
if [[ -s "$KILL_LOG" ]]; then
  echo "FAIL: no codex-hud session here, yet something was killed" >&2
  cat "$KILL_LOG" >&2
  exit 1
fi
if [[ "$out" != *"No codex-hud session"* ]]; then
  echo "FAIL: expected a no-session warning" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi

echo "test-kill-scope: PASS"
