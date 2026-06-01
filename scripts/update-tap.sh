#!/usr/bin/env bash
#
# Update the Homebrew tap formula for a published teaminal release.
#
# Rewrites Formula/teaminal.rb in the sibling damsleth/homebrew-tap checkout
# to prebuilt-archive URLs with the sha256 values pulled from the release's
# SHA256SUMS.txt, then commits the change in the tap repo.
#
# Run this AFTER the GitHub Release for the tag is live: the checksums come
# from the CI-built artifacts on the release, not from a local build, so the
# formula's sha256 values match what users actually download.
#
# Usage:
#   scripts/update-tap.sh [vX.Y.Z] [path-to-tap-repo]
#
#   version       defaults to the v-prefixed version in package.json
#   tap repo      defaults to ../homebrew-tap
#
# Options (via env):
#   CHECKSUMS=/path/to/SHA256SUMS.txt   use a local checksums file instead of
#                                       downloading it from the release
#   NO_COMMIT=1                         write the formula but skip the commit

set -euo pipefail

cd "$(dirname "$0")/.."
repo_root="$(pwd)"

# --- resolve version -------------------------------------------------------
version_arg="${1:-}"
if [[ -n "$version_arg" ]]; then
  version="${version_arg#v}"
else
  version="$(node -p "require('./package.json').version" 2>/dev/null || true)"
  if [[ -z "$version" ]]; then
    echo "error: could not read version from package.json; pass it explicitly: scripts/update-tap.sh v0.18.0" >&2
    exit 1
  fi
fi
tag="v${version}"

# --- resolve tap repo ------------------------------------------------------
tap_dir="${2:-../homebrew-tap}"
formula="${tap_dir}/Formula/teaminal.rb"
if [[ ! -f "$formula" ]]; then
  echo "error: tap formula not found at ${formula}" >&2
  echo "       pass the tap path: scripts/update-tap.sh ${tag} /path/to/homebrew-tap" >&2
  exit 1
fi

# --- obtain checksums ------------------------------------------------------
tmp_sums=""
cleanup() { [[ -n "$tmp_sums" && -f "$tmp_sums" ]] && rm -f "$tmp_sums"; }
trap cleanup EXIT

if [[ -n "${CHECKSUMS:-}" ]]; then
  sums_file="$CHECKSUMS"
  if [[ ! -f "$sums_file" ]]; then
    echo "error: CHECKSUMS file not found: ${sums_file}" >&2
    exit 1
  fi
else
  sums_url="https://github.com/damsleth/teaminal/releases/download/${tag}/SHA256SUMS.txt"
  tmp_sums="$(mktemp)"
  sums_file="$tmp_sums"
  echo "==> fetching ${sums_url}"
  if ! curl -fsSL "$sums_url" -o "$sums_file"; then
    echo "error: failed to download SHA256SUMS.txt for ${tag}." >&2
    echo "       Is the GitHub Release published yet? Or pass CHECKSUMS=/path/to/SHA256SUMS.txt" >&2
    exit 1
  fi
fi

# --- extract per-platform sha256 ------------------------------------------
sha_for() {
  local platform="$1"
  local name="teaminal-${version}-${platform}.tar.gz"
  local sha
  sha="$(awk -v f="$name" '$2 == f {print $1}' "$sums_file" | head -n1)"
  if [[ -z "$sha" ]]; then
    echo "error: no checksum for ${name} in SHA256SUMS.txt" >&2
    echo "       (does the release version match ${version}?)" >&2
    exit 1
  fi
  printf '%s' "$sha"
}

sha_darwin_arm64="$(sha_for darwin-arm64)"
sha_darwin_x64="$(sha_for darwin-x64)"
sha_linux_x64="$(sha_for linux-x64)"
sha_linux_arm64="$(sha_for linux-arm64)"

# --- render formula --------------------------------------------------------
echo "==> writing ${formula} (teaminal ${version})"
cat > "$formula" <<EOF
class Teaminal < Formula
  desc "Lightweight terminal Microsoft Teams client"
  homepage "https://github.com/damsleth/teaminal"
  version "${version}"
  license "MIT"

  depends_on "damsleth/tap/owa-piggy" => :recommended

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/damsleth/teaminal/releases/download/v#{version}/teaminal-#{version}-darwin-arm64.tar.gz"
      sha256 "${sha_darwin_arm64}"
    else
      url "https://github.com/damsleth/teaminal/releases/download/v#{version}/teaminal-#{version}-darwin-x64.tar.gz"
      sha256 "${sha_darwin_x64}"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/damsleth/teaminal/releases/download/v#{version}/teaminal-#{version}-linux-arm64.tar.gz"
      sha256 "${sha_linux_arm64}"
    else
      url "https://github.com/damsleth/teaminal/releases/download/v#{version}/teaminal-#{version}-linux-x64.tar.gz"
      sha256 "${sha_linux_x64}"
    end
  end

  def install
    bin.install "teaminal"
  end

  test do
    assert_match "teaminal #{version}", shell_output("#{bin}/teaminal --version")
  end
end
EOF
chmod 644 "$formula"

# Mirror the authoritative formula into the teaminal repo's draft copy so the
# two never drift (RELEASING.md tracks docs/homebrew/teaminal.rb as the draft).
cp "$formula" "${repo_root}/docs/homebrew/teaminal.rb"

# --- commit in the tap -----------------------------------------------------
if [[ "${NO_COMMIT:-}" == "1" ]]; then
  echo "==> NO_COMMIT=1 set; formula written, skipping commit"
  echo "    review: git -C ${tap_dir} diff"
  exit 0
fi

if ! git -C "$tap_dir" diff --quiet -- Formula/teaminal.rb; then
  git -C "$tap_dir" add Formula/teaminal.rb
  git -C "$tap_dir" commit -m "teaminal ${version}" >/dev/null
  echo "==> committed teaminal ${version} in ${tap_dir}"
  echo "    push it:  git -C ${tap_dir} push"
else
  echo "==> formula already at ${version}; nothing to commit"
fi
