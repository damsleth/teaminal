# Release and Homebrew Notes

teaminal currently supports macOS release binaries only:

- `bun-darwin-arm64`
- `bun-darwin-x64`

Keep `scripts/build.sh`, `README.md`, this file, and the Homebrew formula in sync whenever supported platforms or artifact names change.

## Build Artifacts

For each release tag, build both supported targets and publish release assets named exactly:

- `teaminal-VERSION-darwin-arm64.tar.gz`
- `teaminal-VERSION-darwin-x64.tar.gz`

Each archive should contain a single executable named `teaminal`.

Example:

```bash
TARGET=bun-darwin-arm64 ./scripts/build.sh
tar -C dist -czf teaminal-0.5.0-darwin-arm64.tar.gz teaminal

TARGET=bun-darwin-x64 ./scripts/build.sh
tar -C dist -czf teaminal-0.5.0-darwin-x64.tar.gz teaminal
```

Generate checksums after uploading or before editing the tap:

```bash
shasum -a 256 teaminal-0.5.0-darwin-arm64.tar.gz
shasum -a 256 teaminal-0.5.0-darwin-x64.tar.gz
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
  version "0.5.0"
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

1. Confirm `package.json`, `bin/teaminal.tsx`, `CHANGELOG.md`, `README.md`, `scripts/build.sh`, and this file all agree on the release version and supported targets.
2. Build and smoke both release assets with `TARGET=bun-darwin-arm64 ./scripts/build.sh` and `TARGET=bun-darwin-x64 ./scripts/build.sh`.
3. Archive each `dist/teaminal` binary using the artifact names above.
4. Create the GitHub release and upload both archives.
5. Compute SHA-256 values and update `Formula/teaminal.rb` in the tap.
6. Run `brew audit --strict --online teaminal` and `brew test teaminal` from the tap.
7. Install from the tap on Apple Silicon and Intel macOS, or at least verify both URLs and checksums before publishing the tap commit.
