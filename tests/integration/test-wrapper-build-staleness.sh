#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
FAKE_TMUX_DIR="$SCRIPT_DIR/fake-tmux"
TEMP_ROOT="$(mktemp -d)"
FAKE_BIN_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TEMP_ROOT" "$FAKE_BIN_DIR"
}
trap cleanup EXIT

mkdir -p "$TEMP_ROOT/bin" "$TEMP_ROOT/src/collectors" "$TEMP_ROOT/dist" "$TEMP_ROOT/node_modules"
cp "$ROOT_DIR/bin/codex-hud" "$TEMP_ROOT/bin/codex-hud"

: > "$TEMP_ROOT/dist/index.js"
: > "$TEMP_ROOT/src/index.ts"
: > "$TEMP_ROOT/src/collectors/session-finder.ts"
touch -t 202606010000 "$TEMP_ROOT/dist/index.js"
touch -t 202605010000 "$TEMP_ROOT/src/index.ts"
touch -t 202606020000 "$TEMP_ROOT/src/collectors/session-finder.ts"

cat > "$FAKE_BIN_DIR/codex" <<'FAKE'
#!/usr/bin/env bash
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

npm_log="$(mktemp)"
cat > "$FAKE_BIN_DIR/npm" <<FAKE
#!/usr/bin/env bash
echo "npm \$*" >> "$npm_log"
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

export PATH="$FAKE_BIN_DIR:$FAKE_TMUX_DIR:$PATH"
export CODEX_HUD_HEIGHT="5"
export CODEX_HUD_HEIGHT_AUTO="0"
export TMUX_LOG_FILE="$(mktemp)"
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
export TMUX_MAIN_PANE_IN_MODE="0"
export TMUX_REJECT_TARGET_0="1"

"$TEMP_ROOT/bin/codex-hud" >/tmp/codex-hud-build-staleness.log 2>&1

if ! grep -q '^npm run build$' "$npm_log"; then
  echo "expected wrapper to rebuild when any src TypeScript file is newer than dist/index.js" >&2
  echo "npm log:" >&2
  cat "$npm_log" >&2
  echo "wrapper output:" >&2
  cat /tmp/codex-hud-build-staleness.log >&2
  exit 1
fi

echo "test-wrapper-build-staleness: PASS"
