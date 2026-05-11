# Contributing

Thanks for poking at teaminal. This is a small, opinionated project - the
goal is a fast, keyboard-driven terminal client that stays out of your way,
not a Teams desktop replacement. Patches that fit that shape are welcome.

## Setup

- [Bun](https://bun.sh) `>= 1.1.0` for dev and local builds.
- [`owa-piggy`](https://github.com/damsleth/owa-piggy) installed and
  authenticated for at least one Microsoft 365 profile.
- A terminal with raw-mode input support.

```bash
bun install
bun run dev
```

Useful commands:

```bash
bun test                 # unit tests (fast, no network)
bun run typecheck        # tsc --noEmit
bun run format           # prettier
bun run build            # single-file binary at dist/teaminal
```

## Architecture rules

Before changing anything non-trivial, read [`AGENTS.md`](./AGENTS.md). The
short version:

1. **Dependency direction:**
   `bin/` -> `src/ui/` -> `src/state/` -> `src/graph/` -> `src/auth/`.
   Lower layers never import upward.
2. **Polling, not pushing.** All data freshness comes from
   `src/state/poller.ts`. UI components read from the store, never from
   `src/graph/*` directly.
3. **Auth boundary.** Only `src/auth/owaPiggy.ts` spawns subprocesses.
   Only `src/graph/client.ts` injects `Authorization` headers.

Patches that break those rules will get bounced back even if the feature
itself is good.

## Testing

- `*.test.ts` co-located with the source file
  (e.g. `src/auth/owaPiggy.test.ts`).
- JWT and HTTP-response fixtures only - never put real tokens, real
  account IDs, or tenant-identifying strings in tests.
- Cover the boundaries: token expiry edge cases, 401-then-retry, 429
  with `Retry-After`, AppleScript escaping, HTML -> ANSI conversion.

For changes that touch the Graph or chatsvc transport, run the
end-to-end suite against your own owa-piggy profile:

```bash
bun run e2e                          # all read-only tests
bun run e2e -- --profile work        # specific owa-piggy profile
TEAMINAL_E2E_MUTATING=1 bun run e2e  # also runs send/create tests
```

E2E mutating tests post to your real Teams account; do not set
`TEAMINAL_E2E_MUTATING=1` casually. See [`e2e/README.md`](./e2e/README.md)
for the full surface.

## Code style

- No semicolons, 2-space indent, Prettier defaults.
- `import type { ... }` for type-only imports
  (`verbatimModuleSyntax` is on).
- Errors export from their module: `OwaPiggyError`, `GraphError`,
  `RateLimitError`.
- stdout = data, stderr = logs/errors. Debug logging is gated behind
  `TEAMINAL_DEBUG=1`.
- Never log access tokens, refresh tokens, or full `Authorization`
  headers - not even under `TEAMINAL_DEBUG`.
- Comments only when the why is non-obvious.
- No emoji in source or docs. No emdash; use a regular dash.

## Commits and PRs

- Conventional-ish commits: `feat: ...`, `fix(ui): ...`,
  `refactor(graph): ...`. The git log is the changelog source - keep
  subjects short and descriptive.
- One concern per PR where practical. Mixed refactors + features make
  review harder than it has to be.
- Update [`CHANGELOG.md`](./CHANGELOG.md) under `## [Unreleased]` for
  any user-visible change. Internal-only refactors don't need an entry.
- If you change CLI flags, config keys, or keybindings, update
  [`README.md`](./README.md) in the same PR.
- For release-affecting changes (build, packaging, supported
  platforms, artifact names), see [`RELEASING.md`](./RELEASING.md).

## Don't

- Don't bypass `graph<T>()` - the wrapper handles 401 retry, 429
  backoff, token injection, and pagination.
- Don't call `owa-piggy token --json` - that mode leaks rotated
  refresh tokens. Always use default-mode stdout.
- Don't regex-parse Teams HTML. Use the existing `htmlToText` path
  in `src/ui/html.ts` so `<at>` mentions and entities stay correct.
- Don't add third-party runtime dependencies without an issue first.
  teaminal aims for a small dependency surface; every new dep is a
  supply-chain question.

## Security

If you find a security issue, do **not** open a public GitHub issue.
See [`SECURITY.md`](./SECURITY.md) for the private-reporting flow.
