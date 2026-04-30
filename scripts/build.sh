#!/usr/bin/env bash
#
# Compile teaminal into a single binary for a supported macOS architecture.
#
# Defaults to the current host architecture when running on macOS; override
# via the TARGET env var to cross-build:
#   TARGET=bun-darwin-arm64 ./scripts/build.sh
#   TARGET=bun-darwin-x64 ./scripts/build.sh

set -euo pipefail

cd "$(dirname "$0")/.."

ENTRY="bin/teaminal.tsx"
OUT="dist/teaminal"
SUPPORTED_TARGETS=("bun-darwin-arm64" "bun-darwin-x64")

default_target() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "${os}:${arch}" in
    Darwin:arm64) echo "bun-darwin-arm64" ;;
    Darwin:x86_64) echo "bun-darwin-x64" ;;
    *)
      cat >&2 <<EOF
teaminal build error: unsupported host platform ${os}/${arch}

teaminal currently ships compiled binaries for macOS only:
  - bun-darwin-arm64
  - bun-darwin-x64

To cross-build one of those targets, run:
  TARGET=bun-darwin-arm64 ./scripts/build.sh
  TARGET=bun-darwin-x64 ./scripts/build.sh
EOF
      exit 2
      ;;
  esac
}

TARGET="${TARGET:-$(default_target)}"

case " ${SUPPORTED_TARGETS[*]} " in
  *" ${TARGET} "*) ;;
  *)
    cat >&2 <<EOF
teaminal build error: unsupported target '${TARGET}'

teaminal currently supports macOS targets only:
  - bun-darwin-arm64
  - bun-darwin-x64

Set TARGET to one of the supported values, for example:
  TARGET=bun-darwin-arm64 ./scripts/build.sh
EOF
    exit 2
    ;;
esac

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
