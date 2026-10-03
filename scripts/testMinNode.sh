#!/bin/sh
# Runs the test suite on the minimum supported Node (22.18.0), fetched from the official
# distribution and verified against its SHASUMS256.txt before use.
# PRWC_NODE_DIST overrides the distribution URL, PRWC_NODE_CACHE the cache directory.
# Relative cache paths are resolved against the repository root.
set -eu

VERSION=22.18.0

case $0 in
    */*) SCRIPT_DIR=${0%/*} ;;
    *) SCRIPT_DIR=. ;;
esac
ROOT=$(cd "$SCRIPT_DIR/.." && pwd -P)
cd "$ROOT"

DIST=${PRWC_NODE_DIST:-https://nodejs.org/dist}
CACHE=${PRWC_NODE_CACHE:-.cache/node22}
mkdir -p "$CACHE"
CACHE=$(cd "$CACHE" && pwd -P)

case $(uname -s) in
    Darwin) PLATFORM=darwin ;;
    Linux) PLATFORM=linux ;;
    *)
        echo 'unsupported platform' >&2
        exit 1
        ;;
esac

case $(uname -m) in
    x86_64) ARCH=x64 ;;
    arm64 | aarch64) ARCH=arm64 ;;
    *)
        echo 'unsupported arch' >&2
        exit 1
        ;;
esac

NAME=node-v$VERSION-$PLATFORM-$ARCH
NODE_BIN=$CACHE/$NAME/bin

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | sed -e 's/ .*//' | tr 'A-F' 'a-f'
    else
        shasum -a 256 "$1" | sed -e 's/ .*//' | tr 'A-F' 'a-f'
    fi
}

installed_version() {
    if [ -x "$NODE_BIN/node" ]; then
        "$NODE_BIN/node" --version 2>/dev/null || true
    fi
}

if [ "$(installed_version)" != "v$VERSION" ]; then
    DL=$CACHE/dl
    TARBALL=$DL/$NAME.tar.gz
    mkdir -p "$DL"
    curl -fsSL -o "$TARBALL" "$DIST/v$VERSION/$NAME.tar.gz"
    curl -fsSL -o "$DL/SHASUMS256.txt" "$DIST/v$VERSION/SHASUMS256.txt"
    PATTERN=$(printf '%s' "$NAME.tar.gz" | sed -e 's/\./\\./g')
    EXPECTED=$(grep "  $PATTERN\$" "$DL/SHASUMS256.txt" | sed -n -e '1s/ .*//p' | tr 'A-F' 'a-f' || true)
    ACTUAL=$(sha256_of "$TARBALL")
    if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
        echo "checksum mismatch for $NAME.tar.gz" >&2
        rm -f "$TARBALL"
        exit 1
    fi
    echo 'sha256 OK'
    tar -xzf "$TARBALL" -C "$CACHE"
    rm -f "$TARBALL"
fi

# Never fall back to a system node: the run is only meaningful on the pinned binary.
GOT=$(installed_version)
if [ "$GOT" != "v$VERSION" ]; then
    echo "expected node v$VERSION at $NODE_BIN/node, got '${GOT:-none}'" >&2
    exit 1
fi

PATH=$NODE_BIN:$PATH
export PATH
echo "node bin: $NODE_BIN"
echo "node version: $GOT"
exec "$NODE_BIN/node" --test --test-timeout=120000 --test-reporter=tap 'tests/**/*.test.ts'
