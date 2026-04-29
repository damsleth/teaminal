#!/usr/bin/env bash
#
# Compile teaminal into a single binary for the host architecture.
#
# Defaults to bun-darwin-arm64 since that's the dev target; override via
# the TARGET env var to cross-build, e.g.:
#   TARGET=bun-linux-x64 ./scripts/build.sh
#   TARGET=bun-darwin-x64 ./scripts/build.sh

set -euo pipefail

cd "$(dirname "$0")/.."

TARGET="${TARGET:-bun-darwin-arm64}"
ENTRY="bin/teaminal.tsx"
OUT="dist/teaminal"

mkdir -p dist

echo "==> bun build --compile --target=${TARGET} ${ENTRY}"
# Ink's reconciler dynamically imports a devtools bridge when
# process.env.DEV === 'true'. The bridge statically imports
# react-devtools-core. Bun's compile mode resolves the dynamic import
# at compile time and bakes it into the bundle; we install the package
# as a devDependency so the runtime resolution succeeds. The bridge
# only attempts to connect when DEV=true at runtime, so this is purely
# bundle-time appeasement.
bun build \
  --compile \
  --target="${TARGET}" \
  "${ENTRY}" \
  --outfile "${OUT}"

echo "==> binary: $(ls -lh "${OUT}" | awk '{print $5, $9}')"

# Smoke: --version should exit 0 quickly. We can't fully exercise the UI
# without a TTY here, but the version path proves modules linked.
echo "==> smoke: ${OUT} --version"
if "${OUT}" --version; then
  echo "build OK"
else
  echo "build smoke failed"
  exit 1
fi
