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
- The formula template in [`scripts/update-tap.sh`](./scripts/update-tap.sh)
  (it generates the authoritative `Formula/teaminal.rb` in
  [`damsleth/homebrew-tap`][tap] and the mirror at
  `docs/homebrew/teaminal.rb`)

[tap]: https://github.com/damsleth/homebrew-tap

## Pre-release checklist

1. `bun install --frozen-lockfile`
2. `bun run typecheck`
3. `bun test`
4. `bun run build && ./dist/teaminal --version` (smoke)
5. CHANGELOG promoted: rename `## [Unreleased]` to
   `## [X.Y.Z] - YYYY-MM-DD`, add a fresh empty `## [Unreleased]`
   above it, update the comparison links at the bottom.
6. `package.json` `"version"` and `bin/teaminal.tsx` `const VERSION`
   both bumped to `X.Y.Z`.

## Cutting a release

```bash
git checkout main
git pull --ff-only

# Bump version in package.json + bin/teaminal.tsx, promote CHANGELOG.
$EDITOR package.json bin/teaminal.tsx CHANGELOG.md
git commit -am "release: vX.Y.Z"
git push

# Annotated tag with release notes in the message.
git tag -a vX.Y.Z -m "vX.Y.Z - <headline>

- bullet: ...
"
git push origin vX.Y.Z
```

The tag push triggers `release.yml`. Verify:

1. The Actions run is green.
2. The GitHub Release has all five archives and `SHA256SUMS.txt`.
3. Each archive extracts to a single `teaminal` (or `teaminal.exe`)
   binary that prints the expected version.

Then update the Homebrew tap from the published release:

```bash
scripts/update-tap.sh           # writes + commits Formula/teaminal.rb
git -C ../homebrew-tap push
```

See [Homebrew tap](#homebrew-tap) below for details.

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
[`damsleth/homebrew-tap`][tap] at `Formula/teaminal.rb`. A mirror is
tracked here at [`docs/homebrew/teaminal.rb`](./docs/homebrew/teaminal.rb)
and is kept in sync automatically by the update script below.

The formula installs prebuilt release archives (no Bun needed at install
time): it points at the per-platform `.tar.gz` on the GitHub Release with
the `sha256` pinned from that release's `SHA256SUMS.txt`, for both macOS
(arm64 / x64) and Linux (arm64 / x64).

### Automated update

[`scripts/update-tap.sh`](./scripts/update-tap.sh) does the whole update:
it pulls `SHA256SUMS.txt` from the published release, renders the formula
for the new version, writes it into the sibling `../homebrew-tap` checkout
(and the mirror here), and commits it in the tap repo.

Run it **after** the GitHub Release for the tag is green — the checksums
must come from the CI-built artifacts, not a local build:

```bash
# Defaults: version from package.json, tap at ../homebrew-tap.
scripts/update-tap.sh

# Or pin the version / tap path explicitly:
scripts/update-tap.sh v0.18.0 ../homebrew-tap

# Then push the tap commit (and optionally verify locally first):
brew style ../homebrew-tap/Formula/teaminal.rb
git -C ../homebrew-tap push
```

Useful env overrides:

- `CHECKSUMS=/path/to/SHA256SUMS.txt` — use a local checksums file instead
  of downloading from the release.
- `NO_COMMIT=1` — write the formula but skip the commit (review first).

The script aborts if the release (or a per-platform checksum) is missing,
so it can't produce a half-filled formula.

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
