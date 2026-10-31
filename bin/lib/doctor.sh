# Sourced by bin/codex-hud; uses its path and reporting helpers.
# Run environment diagnostics
self_check() {
    local failures=0

    echo "Codex HUD self-check"
    echo ""

    if [[ -n "${ZDOTDIR:-}" ]] && [[ ! -d "$ZDOTDIR" ]]; then
        warn "ZDOTDIR is set but does not exist: $ZDOTDIR"
        failures=$((failures + 1))
    fi

    local codex_path
    codex_path=$(command -v codex 2>/dev/null || true)
    if [[ -n "$codex_path" ]]; then
        info "codex: $codex_path"
        if [[ "$codex_path" == "$SCRIPT_DIR/codex-hud" ]]; then
            warn "codex resolves to codex-hud wrapper; fix alias to the real codex CLI."
            failures=$((failures + 1))
        fi
    else
        warn "codex CLI not found in PATH"
        failures=$((failures + 1))
    fi

    if command_exists node; then
        info "node $(node --version)"
        if ! node_version_supported; then
            warn "Node.js 20.19+ is required by chokidar 5."
            failures=$((failures + 1))
        fi
        if ! node "$HUD_DIR/scripts/sqlite-backend.mjs"; then
            failures=$((failures + 1))
        fi
    else
        warn "node not found in PATH"
        failures=$((failures + 1))
    fi

    if command_exists tmux; then
        info "tmux $(tmux -V)"
        local pane_index
        pane_index=$(tmux show-options -gqv pane-base-index)
        if [[ -n "$pane_index" && "$pane_index" != "0" ]]; then
            info "tmux pane-base-index=$pane_index (supported)"
        fi
    else
        warn "tmux not found in PATH"
        failures=$((failures + 1))
    fi

    local rc_file
    rc_file=$(get_shell_rc_file)
    if [[ -z "$rc_file" ]]; then
        warn "Unable to determine shell rc file for: $SHELL"
        failures=$((failures + 1))
    elif [[ ! -f "$rc_file" ]]; then
        warn "RC file not found: $rc_file"
        failures=$((failures + 1))
    elif grep -q "$ALIAS_MARKER" "$rc_file" 2>/dev/null; then
        info "Alias marker found in $rc_file"
    else
        warn "Alias marker not found in $rc_file"
        failures=$((failures + 1))
    fi

    # Not a failure: the hook is optional. But with it unset the states that
    # need a human (approval, a failed turn, a hit limit) stay on the pane
    # only, and a user working in another tmux window never hears of them.
    if [[ -n "${CODEX_HUD_NOTIFY_CMD:-}" ]]; then
        info "Notify hook configured (CODEX_HUD_NOTIFY_CMD)"
    else
        info "Notify hook not configured: set CODEX_HUD_NOTIFY_CMD to be paged for approval / failed-turn / limit events (see --help)"
    fi

    if [[ ! -f "$HUD_DIR/dist/index.js" ]]; then
        warn "HUD build output not found: $HUD_DIR/dist/index.js"
        failures=$((failures + 1))
    elif find "$HUD_DIR/src" -type f \( -name '*.ts' -o -name '*.tsx' \) \
        -newer "$HUD_DIR/dist/index.js" -print -quit | grep -q .; then
        warn "HUD build output is stale; run codex-hud --reload."
        failures=$((failures + 1))
    else
        info "HUD build output is current"
    fi

    # Render errors and uncaught exceptions land in the diagnostics log (see
    # src/utils/hud-log.ts for the resolution chain mirrored here), but until
    # now nothing displayed it — and this command is where users look first
    # when the HUD misbehaves. History is not a current fault, so log entries
    # never count as self-check failures.
    local log_file="${CODEX_HUD_LOG_FILE:-}"
    if [[ "$(printf '%s' "$log_file" | tr '[:upper:]' '[:lower:]')" == "off" ]]; then
        info "HUD diagnostics logging is disabled (CODEX_HUD_LOG_FILE=off)"
    else
        if [[ -z "$log_file" ]]; then
            local log_candidates=()
            if [[ "$OSTYPE" == darwin* ]]; then
                log_candidates+=("$HOME/Library/Logs/codex-hud/hud.log")
            fi
            if [[ -n "${XDG_STATE_HOME:-}" ]]; then
                log_candidates+=("$XDG_STATE_HOME/codex-hud/hud.log")
            else
                log_candidates+=("$HOME/.local/state/codex-hud/hud.log")
            fi
            log_candidates+=("${TMPDIR:-/tmp}/codex-hud/hud.log")
            local log_candidate
            log_file="${log_candidates[0]}"
            for log_candidate in "${log_candidates[@]}"; do
                if [[ -f "$log_candidate" ]]; then
                    log_file="$log_candidate"
                    break
                fi
            done
        fi
        if [[ -s "$log_file" ]]; then
            info "Recent HUD diagnostics ($log_file):"
            tail -n 5 "$log_file" | cut -c 1-300 | sed 's/^/    /'
        else
            info "No HUD diagnostics logged ($log_file)"
        fi
    fi

    if [[ "$failures" -gt 0 ]]; then
        warn "Self-check found $failures issue(s)."
        exit 1
    fi

    info "Self-check passed."
}
