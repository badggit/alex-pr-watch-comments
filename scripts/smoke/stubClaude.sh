#!/bin/sh
# Stand-in claude for the stub mode of the live smoke: the watcher's --claude needs an executable file.
exec node "$(dirname "$0")/stubClaude.ts" "$@"
