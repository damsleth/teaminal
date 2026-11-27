# Security policy

## Supported versions

teaminal is pre-1.0; only the latest tagged release receives security fixes.
For the current release see [CHANGELOG.md](./CHANGELOG.md).

## Reporting a vulnerability

Please **do not** open a public GitHub issue for suspected vulnerabilities.

Use GitHub's [private vulnerability reporting][gh-advisory] for this repo:

[gh-advisory]: https://github.com/damsleth/teaminal/security/advisories/new

Include:

- A description of the issue and the affected component (auth wrapper,
  Graph or Teams-service client, push transport, UI, etc.)
- Steps to reproduce, ideally with a minimal repro
- The teaminal version (`teaminal --version`) and host OS

You can expect an acknowledgement within a few business days. Coordinated
disclosure timelines will be agreed per-report. There is no embargo SLA -
this is a personal project with no deployed service to embargo.

## Threat model

teaminal is a thin terminal client that delegates **all** authentication
to [`owa-piggy`](https://github.com/damsleth/owa-piggy) - a separate
subprocess that holds Microsoft 365 refresh tokens on disk. Threats are
shaped by that boundary:

| Boundary               | Owner       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Refresh token storage  | `owa-piggy` | teaminal never reads or writes the AAD refresh token; it only consumes the short-lived access tokens that `owa-piggy token --audience <audience>` prints to stdout, one audience at a time (Graph and the Teams service audiences).                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Access token in memory | teaminal    | Cached in-process via `src/auth/owaPiggy.ts`, per account and audience; never logged and never written to disk. Each token is sent only to the Microsoft service it was issued for: Microsoft Graph (`graph.microsoft.com`) and the Teams services teaminal uses for what Graph does not cover under delegated auth (`teams.microsoft.com` authsvc and middle tier, the regional chat service `*.ng.msg.teams.microsoft.com`, `presence.teams.microsoft.com`, `chatsvcagg.teams.microsoft.com`, `api.spaces.skype.com`, and, only with `realtimeEnabled`, the trouter push service). The Skype token that authsvc returns is held in memory the same way. |
| Subprocess invocation  | teaminal    | `owa-piggy` is run only by `src/auth/owaPiggy.ts`, always **without** `--json`. The `--json` mode would emit the rotated refresh token from each FOCI exchange (see [Known Pitfalls](./AGENTS.md#known-pitfalls)). The other subprocesses are OS helpers (notifications, appearance, opening links / images / the editor, the emoji picker); the modules allowed to start one are a fixed list checked by `src/architecture.test.ts`.                                                                                                                                                                                                                     |
| HTTP egress            | teaminal    | Graph requests get their bearer only from `src/graph/client.ts`. The Teams-service clients build their own `Authorization` header; the modules that may do so are a fixed list (`AUTH_HEADER_SITES`) checked by `src/architecture.test.ts`, so a new one fails the test. Image downloads from message bodies go to public `http(s)` addresses only, without credentials, and are size-capped while streaming.                                                                                                                                                                                                                                             |
| Notifications          | teaminal    | macOS notifications are dispatched via `osascript` with explicit AppleScript escaping (no shell interpolation, no string concatenation). See `src/notify/notify.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## Practices the project enforces

- `Authorization` headers are never logged, even under `TEAMINAL_DEBUG=1`.
- Request and event logs (`--network-log`, `--log-file`) record method, status,
  duration and a path with ids replaced; push logs carry a status or code with
  a fixed category, never a server response body, socket URL or raw error text.
- On its own teaminal reads from Microsoft 365 (polling, presence, push wakes).
  The one write it makes unprompted is presence: with
  `forceAvailableWhenFocused` (on by default) it registers a presence endpoint
  and keeps your picked availability while the terminal has focus. Everything
  else it writes is something you did (send, edit, delete, react, set presence
  or a status message, create or delete a chat). Favorites, collapsed sections
  and other preferences stay in the local config file.
- Message, chat-list and image caches under `~/.cache/teaminal` are plain files
  readable by your user; **Empty cache** in the menu removes the current
  profile's.
- Mouse reporting is off by default and is switched off again on every exit
  path, so a crash or signal does not leave the terminal sending mouse
  sequences to the shell.
- Tests use synthetic JWTs and HTTP fixtures only - no real tokens or
  account IDs are checked into the repo (see `AGENTS.md` testing rules).
- `verbatimModuleSyntax` is on so accidental top-level side effects from
  type-only imports are caught at compile time.
- The single-binary build (`bun build --compile`) bundles the runtime
  module graph at compile time; runtime resolution is constrained.
- Opening links is restricted to `http(s):` / `mailto:` URLs, so a hostile
  message body cannot smuggle a local path or a shell argument into the
  platform opener.
- An image handed to the platform viewer is written to a per-process
  directory (mode `0700`) as a mode-`0600` file whose name is a SHA-256 of
  the internal cache key - no sender-supplied filename ever reaches the
  filesystem - and the directory is removed on exit. The image-file opener
  refuses any path outside that directory.

## What is **not** in scope

- Hardening of `owa-piggy` itself - report those upstream.
- Hardening of the user's terminal emulator, shell history, or
  `~/.config/teaminal/config` file permissions.
- Microsoft Graph rate-limit or abuse policies - teaminal honors
  `Retry-After` and 429 backoff, but tenant-level enforcement is upstream.
