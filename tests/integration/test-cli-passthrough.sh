#!/usr/bin/env bash
# The installer aliases `codex` to this wrapper, so every Codex subcommand went
# through it. Anything that was not a wrapper flag became "start a tmux session
# and run it in there": `codex exec "..." | jq` produced no output and left a
# detached Codex behind, `codex completion zsh` wrote nothing, `codex --version`
# opened a HUD. This checks that the non-interactive subcommands reach the real
# CLI in place, and that the interactive ones still get a HUD.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
FAKE_BIN_DIR="$(mktemp -d)"
TEST_HOME="$(mktemp -d)"
MARKER="$TEST_HOME/tmux-was-used"

cleanup() {
  rm -rf "$FAKE_BIN_DIR" "$TEST_HOME"
}
trap cleanup EXIT

# A codex that reports how it was called instead of doing anything.
cat > "$FAKE_BIN_DIR/codex" <<'FAKE'
#!/usr/bin/env bash
echo "REAL-CODEX-CLI args=[$*]"
exit 0
FAKE
chmod +x "$FAKE_BIN_DIR/codex"

# A tmux that records that the wrapper tried to build a session, then fails so
# the wrapper stops before doing anything to the real terminal.
cat > "$FAKE_BIN_DIR/tmux" <<FAKE
#!/usr/bin/env bash
case "\${1:-}" in
  -V) echo "tmux 3.4" ;;
  new-session|new-window|split-window)
    echo used > "$MARKER"
    exit 1
    ;;
esac
exit 0
FAKE
chmod +x "$FAKE_BIN_DIR/tmux"

export PATH="$FAKE_BIN_DIR:$PATH"
export CODEX_CLI_PATH="$FAKE_BIN_DIR/codex"
unset TMUX

failures=0
check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    echo "  ok: $label"
  else
    echo "  FAIL: $label"
    echo "    expected to contain: $expected"
    echo "    actual: $actual"
    failures=$((failures + 1))
  fi
}

echo "non-interactive subcommands reach the CLI:"
# agents / queue / migrate-rollouts arrived with codex 0.149; through the
# alias each opened a junk tmux session and `codex queue`'s output vanished
# into a detached pane.
for sub in exec login logout mcp completion doctor apply update archive delete features help agents queue migrate-rollouts; do
  rm -f "$MARKER"
  out="$("$ROOT_DIR/bin/codex-hud" "$sub" --some-flag 2>&1 || true)"
  check "codex $sub" "REAL-CODEX-CLI args=[$sub --some-flag]" "$out"
  if [[ -e "$MARKER" ]]; then
    echo "  FAIL: codex $sub built a tmux session"
    failures=$((failures + 1))
  fi
done

echo "version flags reach the CLI:"
for flag in --version -V; do
  rm -f "$MARKER"
  out="$("$ROOT_DIR/bin/codex-hud" "$flag" 2>&1 || true)"
  check "codex $flag" "REAL-CODEX-CLI args=[$flag]" "$out"
done

echo "stdout survives, so pipes and redirection work:"
out="$("$ROOT_DIR/bin/codex-hud" exec "summarize this" 2>/dev/null | tr -d '\n')"
check "codex exec is pipeable" "REAL-CODEX-CLI args=[exec summarize this]" "$out"

echo "interactive entry points still get a HUD:"
for args in "" "resume" "fork" "write me a test"; do
  rm -f "$MARKER"
  # shellcheck disable=SC2086
  "$ROOT_DIR/bin/codex-hud" $args >/dev/null 2>&1 || true
  if [[ -e "$MARKER" ]]; then
    echo "  ok: codex ${args:-(no args)} builds a session"
  else
    echo "  FAIL: codex ${args:-(no args)} did not build a session"
    failures=$((failures + 1))
  fi
done

echo "wrapper flags are still the wrapper's:"
out="$("$ROOT_DIR/bin/codex-hud" --help 2>&1 || true)"
check "codex-hud --help" "codex-hud - Codex CLI with HUD display" "$out"
check "--help points at the CLI's own help" "codex help" "$out"

if [[ "$failures" -gt 0 ]]; then
  echo "test-cli-passthrough: FAIL ($failures)"
  exit 1
fi
echo "test-cli-passthrough: PASS"
