#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
FAKE_TMUX_DIR="$SCRIPT_DIR/fake-tmux"

export PATH="$FAKE_TMUX_DIR:$PATH"

run_case() {
  local width="$1"
  local window_height="$2"
  local base_height="$3"
  local expected_base="$4"
  local expected="$5"
  local auto_setting="$6"
  local adaptive_setting="$7"
  local env_auto_setting="$8"
  local main_in_mode="$9"
  local focus_main="${10}"
  local stored_main="${11}"

  local log_file
  log_file="$(mktemp)"

  export TMUX_LOG_FILE="$log_file"
  export TMUX_MAIN_PANE_ID="%1"
  export TMUX_STORED_MAIN_PANE="$stored_main"
  export TMUX_PANE_ID="%2"
  export TMUX_PANES=$'%1\n%2'
  export TMUX_BASE_HEIGHT="$base_height"
  export TMUX_HEIGHT="$base_height"
  export TMUX_AUTO="$auto_setting"
  export TMUX_ADAPTIVE="$adaptive_setting"
  export TMUX_HEIGHT_MIN="5"
  export TMUX_HEIGHT_MAX="12"
  export TMUX_PANE_WIDTH="$width"
  export TMUX_PANE_HEIGHT="$base_height"
  export TMUX_WINDOW_HEIGHT="$window_height"
  export TMUX_MAIN_PANE_IN_MODE="$main_in_mode"
  export TMUX_FOCUS_MAIN="$focus_main"

  if [[ -n "$env_auto_setting" ]]; then
    export CODEX_HUD_HEIGHT_AUTO="$env_auto_setting"
  else
    unset CODEX_HUD_HEIGHT_AUTO
  fi

  "$ROOT_DIR/bin/codex-hud-resize" "session-1"

  if [[ "$main_in_mode" == "1" ]]; then
    if grep -q "@codex_hud_height=" "$log_file"; then
      echo "Expected no resize/update when main pane is in copy-mode, log:" >&2
      cat "$log_file" >&2
      exit 1
    fi
    if grep -q "@codex_hud_base_height=" "$log_file"; then
      echo "Expected no adaptive base update when main pane is in copy-mode, log:" >&2
      cat "$log_file" >&2
      exit 1
    fi
    if grep -q "select-pane -t %1" "$log_file"; then
      echo "Expected no focus change when main pane is in copy-mode, log:" >&2
      cat "$log_file" >&2
      exit 1
    fi
    return
  fi

  if [[ "$adaptive_setting" == "1" ]]; then
    if ! grep -q "@codex_hud_base_height=${expected_base}" "$log_file"; then
      echo "Expected adaptive base ${expected_base} for ${window_height} rows, log:" >&2
      cat "$log_file" >&2
      exit 1
    fi
  elif grep -q "@codex_hud_base_height=" "$log_file"; then
    echo "Did not expect a fixed-height session to rewrite its base, log:" >&2
    cat "$log_file" >&2
    exit 1
  fi

  if ! grep -q "@codex_hud_height=${expected}" "$log_file"; then
    echo "Expected height ${expected} for width ${width}, log:" >&2
    cat "$log_file" >&2
    exit 1
  fi

  if [[ "$focus_main" == "1" ]]; then
    if ! grep -q "select-pane -t %1" "$log_file"; then
      echo "Expected focus to return to main pane, log:" >&2
      cat "$log_file" >&2
      exit 1
    fi
  else
    if grep -q "select-pane -t %1" "$log_file"; then
      echo "Did not expect focus change when focus_main=0, log:" >&2
      cat "$log_file" >&2
      exit 1
    fi
  fi
}

# Explicit fixed height remains stable.
run_case 70 60 5 5 5 "0" "0" "" "0" "1" "%1"

# Adaptive sessions recalculate their base from window height, then add bounded
# width compensation for narrow panes.
run_case 120 24 5 5 5 "1" "1" "" "0" "1" "%1"
run_case 120 36 5 6 6 "1" "1" "" "0" "1" "%1"
run_case 120 60 5 10 10 "1" "1" "" "0" "1" "%1"
run_case 90 60 5 10 11 "1" "1" "" "0" "1" "%1"
run_case 70 60 5 10 12 "1" "1" "" "0" "1" "%1"
run_case 50 60 5 10 12 "1" "1" "" "0" "1" "%1"
run_case 120 120 5 12 12 "1" "1" "" "0" "1" "%1"

# Explicit auto mode preserves the previous width-only behavior.
run_case 70 60 5 5 7 "1" "0" "" "0" "1" "%1"

# Copy-mode guard: no resize and no focus hop while main pane is in copy-mode.
run_case 50 60 5 10 12 "1" "1" "" "1" "1" "%1"

# Focus guard can be disabled explicitly.
run_case 70 60 5 5 5 "0" "0" "" "0" "0" "%1"

# If stored main pane is stale, fallback still finds and focuses the real main pane.
run_case 70 60 5 5 5 "0" "0" "" "0" "1" "%9"

# The HUD publishes the rows its content needs; in adaptive mode that is the
# target (clamped), and the width extras no longer apply. An explicit height
# (non-adaptive) ignores it.
export TMUX_FIT_HEIGHT="9"
run_case 50 60 5 10 9 "1" "1" "" "0" "1" "%1"
export TMUX_FIT_HEIGHT="30"
run_case 120 60 5 10 12 "1" "1" "" "0" "1" "%1"
export TMUX_FIT_HEIGHT="2"
run_case 120 60 5 10 5 "1" "1" "" "0" "1" "%1"
export TMUX_FIT_HEIGHT="9"
run_case 70 60 5 5 5 "0" "0" "" "0" "1" "%1"
unset TMUX_FIT_HEIGHT

echo "test-hud-resize: PASS"
