#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/../.."
symbols=tools/ci/retired-symbols.txt
if git grep -n -I -o -F -f "$symbols" -- . ":(exclude)$symbols" \
    ':(exclude).grilltrack/proof/cycle-1/repo-state.txt'; then
    echo 'Found a reference to a retired symbol.' >&2
    exit 1
else
    status=$?
    [ "$status" -eq 1 ] || exit "$status"
fi
