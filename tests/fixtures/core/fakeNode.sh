#!/bin/sh
# Stand-in node for the entry launcher tests: reports FAKE_NODE_VERSION for the version probe, otherwise records
# its arguments one per line in FAKE_NODE_ARGS_FILE and exits 42.
if [ "$#" -eq 2 ] && [ "$1" = "-p" ] && [ "$2" = "process.versions.node" ]; then
    printf '%s\n' "${FAKE_NODE_VERSION:-}"
    exit 0
fi
: > "${FAKE_NODE_ARGS_FILE:?FAKE_NODE_ARGS_FILE is not set}"
for arg in "$@"; do
    printf '%s\n' "$arg" >> "$FAKE_NODE_ARGS_FILE"
done
exit 42
