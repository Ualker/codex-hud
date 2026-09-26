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


# Each record carries its original resolved path; never concatenate shell dialects.
backup_rc_aliases() (
    umask 077
    local rc_path="$1" aliases="$2" entry
    mkdir -p "$BACKUP_FILE.d" || return 1
    entry=$(mktemp -d "$BACKUP_FILE.d/rc.XXXXXX") || return 1
    printf '%s\n' "$rc_path" > "$entry/path" || return 1
    printf '%s' "$aliases" > "$entry/aliases" || return 1
)

restore_rc_aliases() {
    [[ -d "$BACKUP_FILE.d" ]] || return 0
    local entry rc_path temp_file alias_line alias_name conflict
    for entry in "$BACKUP_FILE.d"/rc.*; do
        [[ -f "$entry/path" && -f "$entry/aliases" ]] || continue
        IFS= read -r rc_path < "$entry/path" || continue
        if [[ ! -f "$rc_path" ]]; then
            warn "Original RC file is unavailable; backup retained: $entry"
            continue
        fi
        rc_path=$(resolve_rc_path "$rc_path") || return 1
        temp_file=$(prepare_rc_temp "$rc_path") || return 1
        conflict=0
        while IFS= read -r alias_line || [[ -n "$alias_line" ]]; do
            [[ -n "$alias_line" ]] || continue
            if grep -Fxq -- "$alias_line" "$temp_file"; then continue; fi
            alias_name=$(printf '%s\n' "$alias_line" | sed -E 's/^alias ([^= ]+).*/\1/')
            if grep -Eq "^alias $alias_name(=| )" "$temp_file"; then
                conflict=1
                continue
            fi
            printf '\n%s\n' "$alias_line" >> "$temp_file" || return 1
        done < "$entry/aliases"
        replace_rc_file "$rc_path" "$temp_file" || return 1
        if [[ "$conflict" == 1 ]]; then
            warn "Preserved newer aliases in $rc_path; original backup retained: $entry"
        else
            rm -f "$entry/path" "$entry/aliases"
            rmdir "$entry"
            info "Restored aliases to $rc_path"
        fi
    done
    rmdir "$BACKUP_FILE.d" 2>/dev/null || true
}
