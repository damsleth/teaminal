#!/usr/bin/env bash
#
# Cross-compile all single-file binaries published by the release workflow.
# Outputs one directory per platform under dist/release.

set -euo pipefail

cd "$(dirname "$0")/.."

rm -rf dist/release
mkdir -p dist/release

build_one() {
  local target="$1"
  local platform="$2"
  local exe="$3"
  local out="dist/release/${platform}/${exe}"

  mkdir -p "dist/release/${platform}"
  TARGET="${target}" OUT="${out}" SMOKE=0 ./scripts/build.sh
}

build_one bun-darwin-arm64 darwin-arm64 teaminal
build_one bun-darwin-x64 darwin-x64 teaminal
build_one bun-linux-x64-modern linux-x64 teaminal
build_one bun-linux-arm64 linux-arm64 teaminal
build_one bun-windows-x64 windows-x64 teaminal.exe

echo "==> release binaries:"
find dist/release -maxdepth 2 -type f -print
