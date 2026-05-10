# Release and Homebrew Notes

teaminal publishes single-file Bun executables for:

- `darwin-arm64`
- `darwin-x64`
- `linux-x64`
- `linux-arm64`
- `windows-x64`

Keep `scripts/build.sh`, `README.md`, this file, and the Homebrew formula in sync whenever supported platforms or artifact names change.

## Build Artifacts

For each release tag, the workflow publishes release assets named exactly:

- `teaminal-VERSION-darwin-arm64.tar.gz`
- `teaminal-VERSION-darwin-x64.tar.gz`
- `teaminal-VERSION-linux-x64.tar.gz`
- `teaminal-VERSION-linux-arm64.tar.gz`
- `teaminal-VERSION-windows-x64.zip`
- `SHA256SUMS.txt`

Each archive should contain a single executable named `teaminal`.

Example:

```bash
./scripts/build-release.sh
```

Generate local archives/checksums with the same logic as CI:

```bash
version=0.12.9
mkdir -p dist/release-archives
tar -C dist/release/darwin-arm64 -czf dist/release-archives/teaminal-${version}-darwin-arm64.tar.gz teaminal
tar -C dist/release/darwin-x64 -czf dist/release-archives/teaminal-${version}-darwin-x64.tar.gz teaminal
tar -C dist/release/linux-x64 -czf dist/release-archives/teaminal-${version}-linux-x64.tar.gz teaminal
tar -C dist/release/linux-arm64 -czf dist/release-archives/teaminal-${version}-linux-arm64.tar.gz teaminal
(cd dist/release/windows-x64 && zip -9 ../../release-archives/teaminal-${version}-windows-x64.zip teaminal.exe)
(cd dist/release-archives && shasum -a 256 * > SHA256SUMS.txt)
```

## Homebrew Tap

The local tap path seen during this work was:

```text
/Users/damsleth/code/homebrew-tap
```

That path is outside the writable workspace for this repo, so keep the authoritative template here and apply it to the tap during release.

Target formula path:

```text
/Users/damsleth/code/homebrew-tap/Formula/teaminal.rb
```

The current source-build formula is tracked at
`docs/homebrew/teaminal.rb`. Copy that file into the tap while release
assets are still pending. Once GitHub release archives exist, update the
tap formula to use the archive URLs and SHA-256 values instead of building
from `main`.

Release-archive formula template:

```ruby
class Teaminal < Formula
  desc "Lightweight terminal Microsoft Teams client"
  homepage "https://github.com/damsleth/teaminal"
  version "0.12.9"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/damsleth/teaminal/releases/download/v#{version}/teaminal-#{version}-darwin-arm64.tar.gz"
      sha256 "REPLACE_WITH_DARWIN_ARM64_SHA256"
    else
      url "https://github.com/damsleth/teaminal/releases/download/v#{version}/teaminal-#{version}-darwin-x64.tar.gz"
      sha256 "REPLACE_WITH_DARWIN_X64_SHA256"
    end
  end

  depends_on "owa-piggy"

  def install
    bin.install "teaminal"
  end

  test do
    assert_match "teaminal #{version}", shell_output("#{bin}/teaminal --version")
  end
end
```

Release steps:

1. Confirm `package.json`, `bin/teaminal.tsx`, `CHANGELOG.md`, `README.md`, `scripts/build.sh`, `.github/workflows/release.yml`, and this file all agree on the release version and supported targets.
2. Tag the release commit and push the tag.
3. Confirm the GitHub Actions release workflow succeeds.
4. Confirm the GitHub release has all five platform archives and `SHA256SUMS.txt`.
5. Compute SHA-256 values and update `Formula/teaminal.rb` in the tap.
6. Run `brew audit --strict --online teaminal` and `brew test teaminal` from the tap.
7. Install from the tap on Apple Silicon and Intel macOS, or at least verify both URLs and checksums before publishing the tap commit.
