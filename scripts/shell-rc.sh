#!/usr/bin/env bash
# Shared by install/uninstall. Rewrite the target of a dotfile symlink while
# preserving its mode/metadata, using an atomic rename on the same filesystem.
resolve_rc_path() {
    local rc_path="$1" link hops=0
    while [[ -L "$rc_path" ]]; do
        hops=$((hops + 1))
        if (( hops > 40 )); then
            echo "Unable to resolve RC symlink: $1" >&2
            return 1
        fi
        link=$(readlink "$rc_path") || return 1
        case "$link" in
            /*) rc_path="$link" ;;
            *) rc_path="$(dirname "$rc_path")/$link" ;;
        esac
    done
    if [[ -e "$rc_path" && ! -f "$rc_path" ]]; then
        echo "RC target is not a regular file: $rc_path" >&2
        return 1
    fi
    printf '%s\n' "$rc_path"
}

prepare_rc_temp() {
    local rc_path="$1" temp_path
    temp_path=$(mktemp "${rc_path}.codex-hud.XXXXXX") || return 1
    if ! cp -p "$rc_path" "$temp_path"; then
        rm -f "$temp_path"
        return 1
    fi
    printf '%s\n' "$temp_path"
}

replace_rc_file() {
    local rc_path="$1" temp_path="$2"
    if cmp -s "$rc_path" "$temp_path"; then
        rm -f "$temp_path"
    elif ! mv -f "$temp_path" "$rc_path"; then
        rm -f "$temp_path"
        return 1
    fi
}
