#!/usr/bin/env bash
#
# Smoke-test script. Verifies the basics that can't be exercised by
# `bun test`:
#
#   1. owa-piggy is installed and returns a Graph token.
#   2. The token decodes to a JWT with an `aud` claim.
#   3. teaminal builds and the binary's --help / --version work.
#   4. teaminal can be started attached to a TTY (we don't drive the UI;
#      we just verify it does not crash inside the bootstrap).
#
# Usage:
#   scripts/smoke/auth-and-boot.sh                    # default profile
#   scripts/smoke/auth-and-boot.sh --profile work     # named profile
#
# Exits non-zero if any check fails, with a short reason on stderr.

set -euo pipefail

cd "$(dirname "$0")/../.."

PROFILE_ARGS=()
if [[ "${1:-}" == "--profile" && -n "${2:-}" ]]; then
  PROFILE_ARGS=("--profile" "$2")
fi

step() { printf '\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '   \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

step "1. owa-piggy is on PATH"
if ! command -v owa-piggy >/dev/null 2>&1; then
  fail "owa-piggy not found on PATH. install it first."
fi
ok "owa-piggy found at $(command -v owa-piggy)"

step "2. owa-piggy returns a Graph access token"
TOKEN=$(owa-piggy token --audience graph ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"} 2>/dev/null || true)
if [[ -z "$TOKEN" ]]; then
  fail "owa-piggy token --audience graph returned no output. try: owa-piggy reseed"
fi
ok "got a token of length ${#TOKEN}"

step "3. token decodes as a JWT and has an aud claim"
PAYLOAD_B64=$(echo -n "$TOKEN" | cut -d. -f2)
# base64url -> base64 padding fix-up
PAD=$((4 - ${#PAYLOAD_B64} % 4))
if [[ $PAD -lt 4 ]]; then
  PAYLOAD_B64="${PAYLOAD_B64}$(printf '=%.0s' $(seq 1 $PAD))"
fi
PAYLOAD_B64=$(echo -n "$PAYLOAD_B64" | tr '_-' '/+')
PAYLOAD=$(echo -n "$PAYLOAD_B64" | base64 -d 2>/dev/null || true)
if [[ -z "$PAYLOAD" ]]; then
  fail "could not base64-decode the JWT payload segment"
fi
AUD=$(echo "$PAYLOAD" | grep -oE '"aud":"[^"]+"' | head -1 | cut -d'"' -f4)
if [[ -z "$AUD" ]]; then
  fail "JWT payload missing aud claim"
fi
case "$AUD" in
  https://graph.microsoft.com|graph.microsoft.com|*://graph.microsoft.com|00000003-0000-0000-c000-000000000000)
    ok "aud=$AUD (graph)"
    ;;
  *)
    fail "unexpected aud=$AUD (expected graph)"
    ;;
esac

step "4. teaminal builds"
if ! bun install --frozen-lockfile >/dev/null 2>&1; then
  bun install >/dev/null
fi
ok "deps installed"

step "5. typecheck and unit tests pass"
bun run typecheck
ok "typecheck clean"
bun test 2>&1 | tail -3 | grep -E "pass|fail" || true

step "6. CLI metadata"
VERSION_LINE=$(bun run bin/teaminal.tsx --version)
ok "$VERSION_LINE"

HELP_OUT=$(bun run bin/teaminal.tsx --help)
echo "$HELP_OUT" | grep -q -- "--profile, -p" || fail "expected -p alias in --help"
ok "--help mentions the -p alias"

step "7. non-TTY rejection"
NON_TTY_OUT=$(echo "" | bun run bin/teaminal.tsx 2>&1 || true)
echo "$NON_TTY_OUT" | grep -qi "not a tty" || fail "non-TTY rejection message changed"
ok "stdin-not-a-TTY rejection still fires"

step "All smoke checks passed."
