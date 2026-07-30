#!/usr/bin/env bash

set -euo pipefail

suite="${1:-}"
case "$suite" in
    unit)
        roots=("tests/unit")
        ;;
    integration)
        roots=("tests/integration")
        ;;
    *)
        echo "Usage: tests/run-suite.sh unit|integration" >&2
        exit 2
        ;;
esac

files=()
for root in "${roots[@]}"; do
    while IFS= read -r file; do
        files+=("$file")
    done < <(find "$root" -maxdepth 1 -type f \( -name '*.mjs' -o -name '*.sh' \) | LC_ALL=C sort)
done

if [[ "${#files[@]}" -eq 0 ]]; then
    echo "No tests found for suite: $suite" >&2
    exit 1
fi

for file in "${files[@]}"; do
    echo "==> $file"
    case "$file" in
        *.mjs)
            node "$file"
            ;;
        *.sh)
            bash "$file"
            ;;
    esac
done
