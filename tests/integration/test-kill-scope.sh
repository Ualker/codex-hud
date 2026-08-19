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

# Default scope: only the newest session for this directory.
out="$(run_kill --kill)"
assert_killed "$NEW" "--kill takes only the newest session"
if [[ "$out" != *"$NEW"* ]]; then
  echo "FAIL: --kill must name what it killed" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi
if [[ "$out" != *"--kill --all"* ]]; then
  echo "FAIL: --kill must point at the wider scope when sessions remain" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi

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
if [[ "$out" != *"No session found"* ]]; then
  echo "FAIL: expected a no-session warning" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi

echo "test-kill-scope: PASS"
