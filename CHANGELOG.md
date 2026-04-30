# Changelog

All notable changes to teaminal are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.0] - 2026-04-30

### Added

- `~/.config/teaminal/config.json` (or `$XDG_CONFIG_HOME/teaminal/config.json`)
  is read at startup. Any subset of the `Settings` keys can be set there:
  `theme`, `chatListDensity`, `chatListShortNames`, `showPresenceInList`,
  `showTimestampsInPane`, `windowHeight`. Unknown keys / wrong-shape values
  produce stderr warnings and fall back to defaults. New `src/config/`
  module exports `loadSettings()` and `mergeSettings()`.
- `chatListShortNames: boolean` setting (and a Settings menu toggle).

### Changed

- Sidebar chat rows again default to **full** member names (the previous
  release showed first names unconditionally). Set
  `"chatListShortNames": true` in `config.json` (or flip the menu toggle)
  to restore the compact form. The MessagePane header always uses the
  full form regardless.

## [0.3.2] - 2026-04-30

### Changed

- `chatLabel` accepts `{ compact: true }` to render member names in
  short form (first name only). The chat list sidebar now uses compact
  for 1:1 and group chats - "Finn" / "Anna, Bjorn, +1" instead of
  "Nordling, Finn Saethre". The MessagePane header still uses the full
  form. Filter matching is unaffected (it still operates on the full
  label stored on the SelectableItem).

## [0.3.1] - 2026-04-30

### Changed

- Message rows in the message pane now show only the sender's first name
  (extracted via the new `shortName` helper, which handles the corporate
  "Surname, Firstname" AD format). The chat header still shows the full
  name. Sender column narrowed from 16 to 10 chars - rows are no longer
  full of ellipsis-truncated `Nordling, Finn ...` / `Damsleth, Carl ...`.

## [0.3.0] - 2026-04-30

### Added

- "Diagnostics" entry under Help in the modal menu. Shows the active
  profile, connection state, last successful list-poll time, capability
  probe results (with colored status dots), and the live access token's
  `tid` / `appid` / `aud` / `upn` / `oid` / `exp` claims plus the full
  `scp` scope list. Useful for debugging why an endpoint returns 403:
  most often the broker token is missing the matching scope (e.g.
  `Presence.Read` for `/me/presence`).
- `decodeJwtClaims(token)` exported from `src/auth/owaPiggy.ts` returning
  the full payload object. `decodeJwtExp` now reuses it.

## [0.2.1] - 2026-04-30

### Fixed

- The full-height layout now pins to the actual terminal row count via
  `useStdout().stdout.rows` (with a `resize` listener) instead of
  `height="100%"`. The CSS-style 100% in Ink resolves against the
  intrinsic content height, which made the box jump when switching
  between chats whose message counts differed; the box now stays a
  fixed full-screen size regardless of focus.

## [0.2.0] - 2026-04-30

### Added

- `Settings.windowHeight` and a corresponding "Window height" entry under
  Settings in the modal menu. Cycles through the presets `full → 20 →
  30 → 40 → full`; default is `full` (fills the terminal). Useful when
  you want to keep prior terminal scrollback visible above the app.

## [0.1.0] - 2026-04-30

First tagged release. The full v1 build sequence is implemented and verified
against a real Microsoft 365 tenant; see `.plans/2026-04-30-v1-status.md`
for the live-smoke matrix.

### Added

- owa-piggy subprocess auth wrapper with single-flight token refresh and an
  in-process cache so the 5s active poll does not pay subprocess spawn cost.
- Microsoft Graph HTTP client (`src/graph/client.ts`) with 401-retry,
  429 backoff honoring `Retry-After`, and per-request `AbortSignal` support.
- Per-resource Graph modules: `/me`, `/chats`, `/teams` (joined teams +
  channels + channel messages), `/me/presence` + bulk presence lookup.
- Startup capability probe that classifies each endpoint as ok / unauthorized
  / unavailable / unknown so the UI can render graceful fallbacks.
- Pub/sub `Store` (`src/state/store.ts`) and a three-loop adaptive poller
  (active 5s, list 30s, presence 60s) with jitter, exponential backoff,
  and focus-driven cancellation of in-flight active fetches.
- Optimistic message send with rollback (`mergeWithOptimistic`) preserving
  in-flight and failed sends across server polls.
- HTML body conversion via `htmlparser2` + `entities` (`src/ui/html.ts`)
  handling `<at>` mentions, `<emoji>`, `<a href>`, and entity refs.
- Cross-chat mention detection from the list-poll (seed-then-fire).
- macOS notification path via `osascript` with explicit AppleScript
  escaping (no shell interpolation).
- Three-pane Ink UI: `ChatList`, `MessagePane`, `Composer`, `StatusBar`,
  `ErrorBoundary`. Modal pause-menu overlays the message pane while
  keeping list / composer / status bar visible.
- Settings: theme (dark/light), chat list density (cozy/compact),
  show-presence-in-list, show-timestamps-in-pane. Cycle on Enter.
- Keybindings reference modal (Help → Keybindings, or `?` from list).
- Status bar shows `name (tenant)`, presence dot, colored connection dot,
  chat count, "upd Ns ago" relative timestamp.
- Background member hydration so 1:1 chat names appear without focusing
  each chat (capped concurrency, hydrated cache to avoid refetch).
- Single-binary build via `bun build --compile` (`scripts/build.sh`).

### Notes

- Per the design contract, `owa-piggy` is always invoked without `--json`.
  The default-mode stdout returns only the access token; `--json` would
  leak the rotated refresh token from every FOCI exchange.
- Other-user presence is not surfaced because the test tenant returns 403
  on `/communications/getPresencesByUserId`. The presence column is wired
  but inert until the tenant grants the capability.
- Typing indicators and a `^D` debug console are deferred (see
  `.plans/TODO.md`).

[Unreleased]: https://github.com/damsleth/teaminal/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/damsleth/teaminal/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/damsleth/teaminal/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/damsleth/teaminal/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/damsleth/teaminal/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/damsleth/teaminal/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/damsleth/teaminal/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/damsleth/teaminal/releases/tag/v0.1.0
