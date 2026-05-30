#!/usr/bin/env bash
#
# Cut a release: bump the version, promote the changelog, commit, and tag.
# A `v*` tag push is what actually builds + publishes (see
# .github/workflows/release.yml), so this script's job is to produce a
# correct, consistent bump commit and tag — deterministically, so the
# three places the version lives never drift and the pre-flight that
# broke v0.17.0 (a stale lockfile vs. --frozen-lockfile in CI) can never
# be skipped.
#
# Usage:
#   ./scripts/release.sh [patch|minor|major|X.Y.Z] [--push] [--no-verify]
#
#   patch (default)  bump the third number   (0.17.0 -> 0.17.1)
#   minor            bump the second, zero the third (0.17.0 -> 0.18.0)
#   major            bump the first, zero the rest   (0.17.0 -> 1.0.0)
#   X.Y.Z            use this exact version
#
#   --push       push main and the tag when done (else prints the commands)
#   --no-verify  skip the install/typecheck/test pre-flight (NOT advised)
#
# The version is bumped in package.json + src/version.ts, the CHANGELOG
# `## [Unreleased]` section is promoted to `## [X.Y.Z] - <today>` with a
# fresh empty Unreleased above it and the compare links updated, then the
# whole thing is committed as `chore(release): X.Y.Z` and tagged vX.Y.Z.

set -euo pipefail
cd "$(dirname "$0")/.."

bump="patch"
do_push=0
verify=1
for arg in "$@"; do
  case "$arg" in
    patch | minor | major) bump="$arg" ;;
    [0-9]*.[0-9]*.[0-9]*) bump="$arg" ;;
    --push) do_push=1 ;;
    --no-verify) verify=0 ;;
    *)
      echo "release: unknown argument: $arg" >&2
      echo "usage: ./scripts/release.sh [patch|minor|major|X.Y.Z] [--push] [--no-verify]" >&2
      exit 2
      ;;
  esac
done

# --- resolve current + next version -----------------------------------

cur="$(grep -m1 '"version":' package.json | sed -E 's/.*"version": "([0-9]+\.[0-9]+\.[0-9]+)".*/\1/')"
if [[ -z "$cur" ]]; then
  echo "release: could not read current version from package.json" >&2
  exit 1
fi
IFS=. read -r ma mi pa <<<"$cur"
case "$bump" in
  patch) new="${ma}.${mi}.$((pa + 1))" ;;
  minor) new="${ma}.$((mi + 1)).0" ;;
  major) new="$((ma + 1)).0.0" ;;
  *) new="$bump" ;;
esac

echo "release: ${cur} -> ${new}"

# --- guards -----------------------------------------------------------

branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$branch" != "main" ]]; then
  echo "release: not on main (on '${branch}'). Release from main." >&2
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "release: working tree is dirty. Commit your feature work first," >&2
  echo "         then run release.sh to make a clean bump commit." >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/v${new}" >/dev/null; then
  echo "release: tag v${new} already exists." >&2
  exit 1
fi

# --- pre-flight (the checks CI runs; failing here is cheaper) ----------

if [[ "$verify" == 1 ]]; then
  echo "release: bun install --frozen-lockfile"
  bun install --frozen-lockfile # the exact check that failed v0.17.0
  echo "release: typecheck"
  bun run typecheck
  echo "release: test"
  bun test
fi

# --- bump version in the two source-of-truth files --------------------

awk -v v="$new" '!d && /^  "version": "/ { print "  \"version\": \"" v "\","; d=1; next } { print }' \
  package.json >package.json.tmp && mv package.json.tmp package.json

verline="export const VERSION = '${new}'"
awk -v line="$verline" \
  '!d && /^export const VERSION = / { print line; d=1; next } { print }' \
  src/version.ts >src/version.ts.tmp && mv src/version.ts.tmp src/version.ts

# --- promote the changelog --------------------------------------------

date="$(date +%F)"
# Derive the compare-URL base from the existing Unreleased link so the
# repo slug is never hardcoded here.
base="$(grep -m1 '^\[Unreleased\]:' CHANGELOG.md | sed -E 's#^\[Unreleased\]: (.*/compare/).*#\1#')"
if [[ -z "$base" ]]; then
  echo "release: could not find the [Unreleased] compare link in CHANGELOG.md" >&2
  exit 1
fi

awk -v ver="$new" -v date="$date" \
  -v unrel_ref="[Unreleased]: ${base}v${new}...HEAD" \
  -v ver_ref="[${new}]: ${base}v${cur}...v${new}" '
  # Promote the heading: keep an empty Unreleased, insert the new version
  # heading just below it so the current notes fall under the new version.
  /^## \[Unreleased\]$/ && !h { print; print ""; print "## [" ver "] - " date; h=1; next }
  # Repoint the Unreleased compare link and add one for the new version.
  /^\[Unreleased\]:/ && !l { print unrel_ref; print ver_ref; l=1; next }
  { print }
' CHANGELOG.md >CHANGELOG.md.tmp && mv CHANGELOG.md.tmp CHANGELOG.md

# --- commit + tag -----------------------------------------------------

git add package.json src/version.ts CHANGELOG.md
git commit -m "chore(release): ${new}"
git tag -a "v${new}" -m "teaminal v${new}"

echo
echo "release: committed chore(release): ${new} and tagged v${new}"
if [[ "$do_push" == 1 ]]; then
  git push origin main
  git push origin "v${new}" # tag push triggers .github/workflows/release.yml
  echo "release: pushed main and v${new}. Watch: gh run watch --workflow=release.yml"
else
  echo "release: not pushed. To publish, run:"
  echo "    git push origin main && git push origin v${new}"
fi
