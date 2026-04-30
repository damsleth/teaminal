# Security policy

## Supported versions

teaminal is pre-1.0; only the latest tagged release receives security fixes.
For the current release see [CHANGELOG.md](./CHANGELOG.md).

## Reporting a vulnerability

Please **do not** open a public GitHub issue for suspected vulnerabilities.
Instead, email `Carl.Joakim.Damsleth@crayon.no` with:

- A description of the issue and the affected component (auth wrapper,
  Graph client, UI, etc.)
- Steps to reproduce, ideally with a minimal repro
- The teaminal version (`teaminal --version`) and host OS

You can expect an acknowledgement within a few business days. Coordinated
disclosure timelines will be agreed per-report.

## Threat model

teaminal is a thin terminal client that delegates **all** authentication
to [`owa-piggy`](https://github.com/damsleth/owa-piggy) - a separate
subprocess that holds Microsoft 365 refresh tokens on disk. Threats are
shaped by that boundary:

| Boundary               | Owner       | Notes                                                                                                                                                                   |
| ---------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Refresh token storage  | `owa-piggy` | teaminal never reads or writes the AAD refresh token; it only consumes the short-lived access tokens that `owa-piggy token --audience graph` prints to stdout.          |
| Access token in memory | teaminal    | Cached in-process via `src/auth/owaPiggy.ts`; never logged, never sent anywhere except `https://graph.microsoft.com`.                                                   |
| Subprocess invocation  | teaminal    | Always invoked **without** `--json`. The `--json` mode would emit the rotated refresh token from each FOCI exchange (see [Known Pitfalls](./AGENTS.md#known-pitfalls)). |
| HTTP egress            | teaminal    | All requests go through `src/graph/client.ts`, which is the single injection point for `Authorization` headers. No other module talks to Graph.                         |
| Notifications          | teaminal    | macOS notifications are dispatched via `osascript` with explicit AppleScript escaping (no shell interpolation, no string concatenation). See `src/notify/notify.ts`.    |

## Practices the project enforces

- `Authorization` headers are never logged, even under `TEAMINAL_DEBUG=1`.
- Tests use synthetic JWTs and HTTP fixtures only - no real tokens or
  account IDs are checked into the repo (see `AGENTS.md` testing rules).
- `verbatimModuleSyntax` is on so accidental top-level side effects from
  type-only imports are caught at compile time.
- The single-binary build (`bun build --compile`) bundles the runtime
  module graph at compile time; runtime resolution is constrained.

## What is **not** in scope

- Hardening of `owa-piggy` itself - report those upstream.
- Hardening of the user's terminal emulator, shell history, or
  `~/.config/teaminal/config` file permissions.
- Microsoft Graph rate-limit or abuse policies - teaminal honors
  `Retry-After` and 429 backoff, but tenant-level enforcement is upstream.
