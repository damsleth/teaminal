# Releasing

teaminal uses [Semantic Versioning](https://semver.org/) and ships
single-file Bun executables driven by tag pushes.

## Tag format

- `vX.Y.Z`

Pushing a tag matching `v*` triggers
[`.github/workflows/release.yml`](./.github/workflows/release.yml). The
workflow typechecks, tests, cross-builds all supported targets, packages
archives, computes `SHA256SUMS.txt`, and attaches everything to the
GitHub Release at the tag. There is no separate PyPI/npm publish step -
the release artifacts are the binaries.

## Supported targets

| Platform            | Release artifact suffix |
| ------------------- | ----------------------- |
| macOS Apple Silicon | `darwin-arm64.tar.gz`   |
| macOS Intel         | `darwin-x64.tar.gz`     |
| Linux x64           | `linux-x64.tar.gz`      |
| Linux arm64         | `linux-arm64.tar.gz`    |
| Windows x64         | `windows-x64.zip`       |

Each archive contains a single binary named `teaminal`
(`teaminal.exe` on Windows). Checksums land in `SHA256SUMS.txt`.

When supported targets, artifact names, or the install flow change,
update all of these together in the same PR:

- [`scripts/build.sh`](./scripts/build.sh)
- [`scripts/build-release.sh`](./scripts/build-release.sh)
- [`.github/workflows/release.yml`](./.github/workflows/release.yml)
- [`README.md`](./README.md)
- This file
- The Homebrew tap formula (`docs/homebrew/teaminal.rb` mirrors the
  authoritative copy in [`damsleth/homebrew-tap`][tap])

[tap]: https://github.com/damsleth/homebrew-tap

## Cutting a release

Use the script — it does the whole bump deterministically so the three
places the version lives never drift, and it runs the same pre-flight CI
runs (the `--frozen-lockfile` check is what failed the v0.17.0 release —
a stale lockfile that a local install would have caught):

```bash
git checkout main && git pull --ff-only
# Commit your feature work FIRST — release.sh requires a clean tree so the
# bump lands as its own commit.

./scripts/release.sh patch           # 0.17.0 -> 0.17.1  (also: minor | major | X.Y.Z)
# Pre-flights (install --frozen-lockfile, typecheck, test), then bumps
# package.json + src/version.ts, promotes the CHANGELOG, commits
# `chore(release): X.Y.Z`, and tags vX.Y.Z. Review, then publish:
git push origin main && git push origin vX.Y.Z

# Or in one shot once you trust it:
./scripts/release.sh patch --push
```

What "promote the CHANGELOG" means (the script does this): the current
`## [Unreleased]` notes become `## [X.Y.Z] - YYYY-MM-DD`, a fresh empty
`## [Unreleased]` is left on top, and the compare links at the bottom are
updated. The version is bumped in **`package.json` `"version"`** and
**`src/version.ts` `VERSION`** (NOT `bin/teaminal.tsx` — `VERSION` moved
to `src/version.ts`).

If you must do it by hand, the pre-flight is: `bun install
--frozen-lockfile` → `bun run typecheck` → `bun test` → `bun run build &&
./dist/teaminal --version` (smoke).

The tag push triggers `release.yml`. Verify:

1. The Actions run is green.
2. The GitHub Release has all five archives and `SHA256SUMS.txt`.
3. Each archive extracts to a single `teaminal` (or `teaminal.exe`)
   binary that prints the expected version.

## Local archive build

The same packaging logic, runnable locally:

```bash
./scripts/build-release.sh

version=0.12.15
mkdir -p dist/release-archives
tar -C dist/release/darwin-arm64 -czf dist/release-archives/teaminal-${version}-darwin-arm64.tar.gz teaminal
tar -C dist/release/darwin-x64 -czf dist/release-archives/teaminal-${version}-darwin-x64.tar.gz teaminal
tar -C dist/release/linux-x64 -czf dist/release-archives/teaminal-${version}-linux-x64.tar.gz teaminal
tar -C dist/release/linux-arm64 -czf dist/release-archives/teaminal-${version}-linux-arm64.tar.gz teaminal
(cd dist/release/windows-x64 && zip -9 ../../release-archives/teaminal-${version}-windows-x64.zip teaminal.exe)
(cd dist/release-archives && shasum -a 256 * > SHA256SUMS.txt)
```

## Homebrew tap

The authoritative formula lives in
[`damsleth/homebrew-tap`][tap] at
`Formula/teaminal.rb`. A draft is tracked here at
[`docs/homebrew/teaminal.rb`](./docs/homebrew/teaminal.rb).

The current draft formula builds from source against `main`. Once a
release exists, the tap formula should switch to release-archive URLs
and pinned SHA-256 values:

```ruby
class Teaminal < Formula
  desc "Lightweight terminal Microsoft Teams client"
  homepage "https://github.com/damsleth/teaminal"
  version "X.Y.Z"
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

After tagging, update the tap:

```bash
# Grab the new checksums from the release.
curl -sL https://github.com/damsleth/teaminal/releases/download/vX.Y.Z/SHA256SUMS.txt

# Update Formula/teaminal.rb in damsleth/homebrew-tap with the new
# version + sha256 values, then:
brew audit --strict --online teaminal
brew test teaminal
```

Install both Apple Silicon and Intel formula paths (or at least verify
both URLs + checksums) before publishing the tap commit.

## Backout / rollback

If a release introduces a regression:

1. Revert the offending PR on `main`.
2. Bump the patch version, update the changelog, tag `vX.Y.(Z+1)`,
   push the tag.
3. If the broken version is referenced by the Homebrew formula, bump
   the tap to the fix version.
4. Document the regression and the fix version in the changelog.

Never force-push tags. Never delete a published GitHub Release. A bad
release is fixed by publishing a higher version, not by rewriting
history.
