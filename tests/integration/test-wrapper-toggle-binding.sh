#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
FAKE_TMUX_DIR="$SCRIPT_DIR/fake-tmux"
TEST_ROOT="$(mktemp -d /tmp/codex-hud-toggle-binding-XXXXXX)"
FAKE_BIN_DIR="$TEST_ROOT/bin"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

mkdir -p "$FAKE_BIN_DIR"

for command_name in codex node npm; do
  cat > "$FAKE_BIN_DIR/$command_name" <<'FAKE'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then
  echo "v20.0.0"
fi
exit 0
FAKE
  chmod +x "$FAKE_BIN_DIR/$command_name"
done

cat > "$FAKE_BIN_DIR/tput" <<'FAKE'
#!/usr/bin/env bash
case "${1:-}" in
  lines) echo "24" ;;
  cols) echo "120" ;;
  *) echo "0" ;;
esac
FAKE
chmod +x "$FAKE_BIN_DIR/tput"

run_case() {
  local label="$1"
  local toggle_value="$2"
  local expected_status="${3:-success}"
  local log_file="$TEST_ROOT/$label.log"
  local output_file="$TEST_ROOT/$label.out"
  local -a env_args=(
    "PATH=$FAKE_BIN_DIR:$FAKE_TMUX_DIR:$PATH"
    "HOME=$TEST_ROOT/home"
    "CODEX_HOME=$TEST_ROOT/codex-home"
    "CODEX_HUD_HEIGHT=5"
    "TMUX_LOG_FILE=$log_file"
    "TMUX_MAIN_PANE_ID=%1"
    "TMUX_PANE_ID=%2"
    $'TMUX_PANES=%1\n%2'
    "TMUX_SPLIT_PANE_ID=%2"
    "TMUX_BASE_HEIGHT=5"
    "TMUX_HEIGHT=5"
    "TMUX_HEIGHT_MIN=5"
    "TMUX_HEIGHT_MAX=12"
    "TMUX_AUTO=0"
    "TMUX_PANE_WIDTH=120"
    "TMUX_PANE_HEIGHT=5"
    "TMUX_MAIN_PANE_IN_MODE=0"
  )
  if [[ -n "$toggle_value" ]]; then
    env_args+=("CODEX_HUD_BIND_TOGGLE=$toggle_value")
  fi

  set +e
  env -u CODEX_HUD_BIND_TOGGLE "${env_args[@]}" \
    bash "$ROOT_DIR/bin/codex-hud" --new-session >"$output_file" 2>&1
  local command_status=$?
  set -e
  if [[ "$expected_status" == "success" && "$command_status" -ne 0 ]]; then
    echo "$label unexpectedly failed" >&2
    cat "$output_file" >&2
    exit 1
  fi
  if [[ "$expected_status" == "failure" && "$command_status" -eq 0 ]]; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  echo "$log_file"
}

default_log="$(run_case default "")"
if grep -q '^bind-key ' "$default_log"; then
  echo "Prefix+H must not be installed by default" >&2
  cat "$default_log" >&2
  exit 1
fi

enabled_log="$(run_case enabled 1)"
if ! grep -q '^bind-key -T prefix H ' "$enabled_log"; then
  echo "Prefix+H must be installed when CODEX_HUD_BIND_TOGGLE=1" >&2
  cat "$enabled_log" >&2
  exit 1
fi

invalid_log="$(run_case invalid sometimes failure)"
if grep -q '^new-session ' "$invalid_log"; then
  echo "an invalid toggle value must fail before creating a tmux session" >&2
  cat "$invalid_log" >&2
  exit 1
fi
if ! grep -Fq "CODEX_HUD_BIND_TOGGLE must be one of" "$TEST_ROOT/invalid.out"; then
  echo "an invalid toggle value must report the accepted values" >&2
  cat "$TEST_ROOT/invalid.out" >&2
  exit 1
fi

echo "test-wrapper-toggle-binding: PASS (default=off explicit=on invalid_preflight=1)"
