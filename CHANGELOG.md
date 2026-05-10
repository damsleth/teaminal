# Changelog

All notable changes to teaminal are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **External-tenant user search via the Teams-web `searchV2` path.**
  HAR-confirmed: when typing an email in the new-chat prompt and
  Graph search returns 0, pressing Enter now POSTs to
  `/api/mt/part/{region}/beta/users/searchV2?...&source=newChat`
  with the bare email as a JSON-string body. Same endpoint Teams
  web uses for the people-picker. Replaces the earlier `users/fetch`
  attempt (which never returned results in our tenant). Cached per
  term for 5 minutes.
- **Direct AAD object id input as the unlinked-tenant escape hatch.**
  HAR shows Teams web only resolves unlinked-tenant users when their
  OID is already cached in IndexedDB - the API alone can't resolve
  email→OID for tenants with no prior interaction. The new-chat
  prompt now accepts a UUID pasted directly as the peer's AAD
  object id and proceeds straight to chat creation. The OID can be
  recovered from any existing thread id
  (`19:selfOid_otherOid@unq.gbl.spaces`).
- **Chatsvc-based 1:1 chat creation when Graph rejects.**
  `createOneOnOneChat` now falls back to
  `POST teams.microsoft.com/api/chatsvc/{region}/v1/threads`
  (Skype-token auth) on Graph 403/404. This is the actual path
  Teams web uses for cross-tenant chats. Verified live: chat
  creation with `kim@damsleth.no`'s OID returns 201 + the canonical
  `unq.gbl.spaces` thread id.
- **Batched chat-member hydration via Graph `/$batch`.** `Shift+R`
  (hard refresh) now clears the per-session "already hydrated" set
  and re-hydrates every chat in 20-chat batches, so chats that show
  as `(1:1)` because their members never loaded resolve to their
  full names. Previously the lazy-on-focus path meant a refresh
  could leave 80%+ of chats unresolved.
- **Batched chat-member hydration via Graph `/$batch`.** `Shift+R`
  (hard refresh) now clears the per-session "already hydrated" set
  and re-hydrates every chat in 20-chat batches, so chats that show
  as `(1:1)` because their members never loaded resolve to their
  full names. Previously the lazy-on-focus path meant a refresh
  could leave 80%+ of chats unresolved.
- **`bun run e2e` agent-driven integration suite.** Runs against the
  real owa-piggy profile (default `swon`) and exercises identity,
  chat list, joined teams, channel listing, channel-message reads
  via chatsvc, external-user search, and federated-conversation
  resolver - asserting on real Graph + chatsvc responses. Each test
  captures the new lines appended to `.tmp/events.log` /
  `.tmp/network.log` so failures surface the diagnostic trail
  inline. Mutating tests (`crud-self`, `crud-linked-tenant`,
  `crud-unlinked-tenant`) are gated behind `TEAMINAL_E2E_MUTATING=1`
  and exercise send + edit + soft-delete against the self-chat,
  a B2B-linked external user, and an unlinked-tenant user via the
  external-search fallback.

### Fixed

- **Chat-list cursor never lands on an unpainted row.** Anchor the
  viewport on the cursor and fill the visual-line budget around it
  (backward then forward) instead of the previous "advance start
  forward" approach that could miscount when row heights drifted
  from the Ink wrap engine's actual layout. Long names still wrap
  onto multiple lines; the cursor row is guaranteed visible.

### Fixed

- **Channel messages no longer "loading..." forever.** `safeText` in
  the chatsvc and federation transports was clipping the response
  body to 1024/400 chars *before* `JSON.parse`, which silently
  truncated valid multi-message bodies into invalid JSON. Reads now
  parse the full body and only clip the diagnostic-display copy.

### Changed

- **Channel reads, sends, and replies always go through Teams
  chatsvc.** owa-piggy / FOCI never issues `ChannelMessage.Read.All`
  or `ChannelMessage.Send` from the OWA refresh token, so the Graph
  attempt was guaranteed-noise. teaminal no longer pings Graph for
  channel messages at all - the chatsvc transport is the only path.
  The `graphChannelReadsBlocked` latch and the "channel reads via
  Graph blocked..." event are gone with it.
- **Diagnostic event when chatsvc returns no usable messages.** When
  the chatsvc messages endpoint returns 2xx but the response is
  empty / shaped differently than expected, teaminal now logs a
  one-shot warning containing the top-level keys, the `messages`
  array length, and a 240-char body excerpt - so an opening channel
  that stays at "loading..." surfaces *why* in the network panel
  instead of looking like a hung poll.

### Added

- **Channel send + reply via Teams chatsvc.**
  `sendChannelMessage` and `postChannelReply` POST to
  `teams.microsoft.com/api/chatsvc/{region}/v1/users/ME/conversations
  /{threadId}/messages` with a Skype-shaped body
  (`messagetype`/`contenttype`/`clientmessageid`, plus
  `properties.parentmessageid` for replies). The canonical message id
  is parsed from the response `Location` header so the optimistic
  composer row is replaced in place.
- **Reactions in chatsvc-fallback channels.** `skypeToChannelMessage`
  now flattens `properties.emotions` into the existing Graph
  `Reaction[]` shape (one entry per (type, user) tuple), so
  `(👍|😊3)` summaries render in fallback channels exactly like
  Graph-served chats.
- **Auth-expired recovery prompt.** When the active owa-piggy profile's
  refresh token has hit its hard expiry (e.g. the SPA 24h cap from
  `AADSTS700084`, or any `invalid_grant`), teaminal now stays mounted
  and offers `r` to reseed the profile (`owa-piggy reseed`), `s` to
  switch to a different profile, or `q` to quit, instead of crashing
  with the raw AAD message.
- **Federated chat canonicalization.** New one-on-one chat creation now
  probes Teams' federated profile and canonical `consumptionhorizons`
  paths before falling back to Graph chat creation, so federated chats
  open the same `@unq.gbl.spaces` thread that Teams web switches to.
  Existing detached one-on-one chats are also redirected to the canonical
  thread when focused.
- **Hard refresh + startup diagnostics.** `Shift+R` now clears visible
  account data and wakes all pollers, while bootstrap/list/active poller
  stages emit structured in-app events so slow startup shows what is in
  flight.
- **Menu build metadata.** The Esc menu now shows the running teaminal
  version and `github.com/damsleth/teaminal` below the logo.
- **Multi-platform release workflow.** Tag releases now build
  single-file Bun executables for macOS, Linux, and Windows, publish
  platform archives, and attach `SHA256SUMS.txt`.
- **Experimental real-time push gate.** New `realtimeEnabled` config key
  enables the trouter-based push transport; it stays off by default so
  polling remains the durable source of truth unless users opt in.
- **Read-receipt display path.** Trouter read-receipt events now update
  per-chat read positions and render subtle `seen by N` lines under
  matching self-sent messages when real-time push is enabled.
- **Real-time push menu toggle.** Menu → Settings now exposes
  `realtimeEnabled` with a restart hint, so users can opt into the
  experimental trouter transport without editing config JSON by hand.
- **HAR-matched Trouter connect flow.** The experimental transport now
  opens the regional `/v4/c` WebSocket, authenticates with an IC3 Teams
  token, handles `trouter.connected`, and completes registrar
  registration with the Skype token.
- **`--log-file <path>`** CLI flag (also `logFile` config key) mirrors
  stderr to a redacted append-only file. Bearer tokens, AAD-style ids,
  and email local parts are scrubbed before each line is written.
- **Network panel** under Menu → Help → Network shows the last 200
  Graph requests (path, method, status, duration, retry flags) sourced
  from a new `recordRequest` ring buffer in `src/log.ts`.
- **Quiet hours** picker in Menu → Settings cycles through preset
  windows (off, 22:00→07:00, 23:00→06:00, 21:00→08:00, 20:00→09:00)
  so users can configure quiet hours without editing config.json.
- **Channel reply badges.** Channel root messages now show
  `╰─ N replies` (or `N+ replies` when a follow-up page exists). The
  active loop opportunistically fetches reply counts for the most
  recent visible roots, throttled to one batch per minute per channel.
- **Quote-on-reply preview.** Entering a thread reply shows a
  `Re: sender: preview` row above the composer so the user sees the
  root post they're replying to.
- **Loading-presence indicator.** 1:1 chat rows render a hollow `◯` in
  muted text while the presence loop hasn't yet resolved that member's
  status (also used while `chat.members` is mid-hydration). Once
  presence lands, the dot becomes filled and colored.
- **`m` toggles unread.** Pressing `m` on a focused chat row in the
  list flips its read/unread state (mark-as-unread / mark-as-read).
- **Tail panels.** Three new toggles in Menu → Settings: `tailEvents`,
  `tailNetwork`, `tailDiagnostics` render 1/3-width strips above the
  composer with a live tail of the corresponding modal panel. Off by
  default; the modal versions remain the canonical surface.
- **System event decoder.** Teams systemEventMessage rows (chat created,
  members added/removed, chat renamed, calls/meetings started/ended,
  recording, transcript) now render as readable lines like
  `Carl added Nina` or `Call ended (12m)`. Subtypes we can't decode are
  hidden from the timeline rather than rendered as a blank
  `(system event)` placeholder.

### Changed

- **Tighter message-pane density.** The chat timeline drops one column
  of outer padding, one column of timestamp gutter, and one trailing
  space after the sender column; sender names now render in bold and
  the sender column auto-sizes to the longest first name in the
  visible conversation (clamped 4–16) so short-name chats stay tight
  and long-name chats no longer truncate.

### Fixed

- **Skype-token exchange now tries the Teams audience first.** The
  `authsvc/v1.0/authz` endpoint frequently rejects default Graph
  audience tokens with a 401 + empty body. teaminal now requests a
  `https://teams.microsoft.com/.default` token, falls back to the
  spaces-scoped token on 401, and surfaces AAD code, www-authenticate
  challenge, correlation id, and body excerpt in the Network panel
  so further failures are diagnosable instead of opaque.
- **Channel reads in tenants without `ChannelMessage.Read.All`
  preauthorization or admin consent.** When Graph returns the 403
  "Missing scope permissions" response, teaminal now falls back to
  the Teams chat service (`teams.microsoft.com/api/chatsvc/{region}/v1
  /users/ME/conversations/{threadId}/messages`) authenticated with a
  Skype token exchanged via `teams.microsoft.com/api/authsvc/v1.0/authz`
  (the same exchange the trouter transport already does), translates
  the Skype-shaped payload into the existing `ChannelMessage` shape,
  and latches the fallback for the rest of the session so Graph is not
  retried.
- **`getMsnp24EquivalentConversationId` now uses the Skype token.**
  The `/api/chatsvc/{region}/v1/users/ME/...` endpoint rejects the
  raw spaces token with errorCode 911 ("Authentication failed"); the
  federated equivalent lookup now goes through the same authsvc-backed
  Skype-token path as channel reads.
- **Federated in-tenant fast-bail covers generic 404s.** Any 404 from
  `fetchFederated` (including "An unexpected error(Type = NotFound)
  occurred") now short-circuits the resolver, not just the explicit
  "in-tenant users" message.
- **`AADSTS65002` scope-fallback at the auth layer.** When `owa-piggy`
  rejects the explicit Graph scope, teaminal now falls back to the
  default Graph audience token for the rest of the session. (Combined
  with the chatsvc fallback above, channel reads work even when both
  the FOCI exchange and the default Graph token lack the scope.)
- **Federated lookup no longer probes in-tenant chats.** A 404 with
  "Federated lookup being incorrectly called for in-tenant users" now
  short-circuits the resolver, and the on-focus path only runs for
  detached chats with no `lastMessagePreview` so populated in-tenant
  chats stop generating Teams chatsvc 401 noise.
- **Chat-list names wrap again, and the viewport tracks visual lines.**
  Long chat names (group rosters, federated externals) wrap onto
  multiple lines; the sidebar viewport now slides based on the
  cumulative *visual* row count instead of logical row count, so
  wrapped labels no longer push neighbours off-screen or squash the
  composer. Truncation is reserved for terminals so narrow that even
  one row's label exceeds the visible budget.
- **Chat-list rendering no longer overlaps adjacent rows.** Long chat
  names and unread previews are truncated instead of wrapping, so the
  sidebar viewport calculation stays in sync with rendered rows and
  the composer no longer collapses when the list grows tall.
- `Tab` now toggles between message navigation and the composer when a
  conversation is open; the composer status hint no longer says
  "Esc navigation".
- `u` / `d` now move half a page in the chats/channels sidebar, matching
  message-pane navigation.
- The chat/team sidebar now uses the live terminal height instead of a
  fixed short viewport, and the user-facing `windowHeight` setting has
  been removed.
- Compact chat-list density no longer spends two columns on the selected
  `>` marker; selected rows rely on bold/color styling.
- Reaction summaries now render as compact counters like `👍|😊3`,
  without colon-wrapping emoji-valued reaction types.
- Message navigation now skips hidden Graph/system rows, fixing a
  date-boundary scroll jump where the focused row disappeared and the
  pane snapped back to the bottom.
- Message text now wraps instead of truncating, and reactions render
  inline after the body / `(edited)` marker as `(👍|😊3)`.
- Message scrolling now keeps the visible window stable until the
  focused message moves above the top row or below the bottom row.
- The inactive composer no longer adds a second help-text row, keeping
  composer height stable between focused and unfocused states.
- Chat-list unread markers now render after the chat name instead of as
  leading dots that can be confused with presence.
- Channel message reads and sends now request the Graph scopes those
  endpoints require: `ChannelMessage.Read.All` and `ChannelMessage.Send`.
- Chat-list rows with presence enabled no longer grow by an extra line
  when selected.
- Entering a chat from list focus no longer crashes `MessagePane` with
  "Rendered more hooks than during the previous render".
- "Load older messages" now triggers from `U` when paging to the top
  or `K` when already at the top, not from `Enter` or `L`.
- Bottom chrome no longer collapses when message rows or status hints
  would otherwise wrap into extra terminal lines.
- Scrolling near the top of a conversation no longer leaves the bottom
  of the message pane blank while newer rows still fit.
- Single-letter shortcuts are now case-insensitive, including `n`/`N`
  for New chat.
- New-chat member search keeps printable `j`/`k` input in the search
  box; Tab moves focus into results before `j`/`k` navigate matches.
- The top-of-history load-more row is hidden once a conversation cache
  is fully loaded.

### Added

- Message reactions are now controlled by the `showReactions` setting:
  `off`, `current` (default), or `all`.
- **In-app event log.** New Events modal (Menu → Help → Event log) shows
  the last 500 structured event records in real time, with a type-ahead
  filter (source / level / message) and color-by-level. `src/log.ts`
  exposes `recordEvent`, `getRecentEvents`, `subscribeEvents`. Existing
  `debug` / `warn` / `error` calls now tee into the buffer so any call
  site already surfaces in the modal.
- **Notification coalescing.** Mentions now coalesce per-conversation
  (default 30s window, 90s cap) and rate-limit globally (5s). The first
  mention in a conv fires immediately when allowed; subsequent ones
  buffer into a digest banner like "A (+1): latest preview (+3 more)".
- **Quiet states for notifications.** Banners are suppressed (bell
  stays) when (a) the user is viewing the active conv (configurable
  via `notifyActiveBanner`), (b) presence is `Presenting` or
  `DoNotDisturb`, (c) inside the configured quiet hours, or (d) when
  `notifyMuted` is on. New menu rows under Settings: 'Mute notifications'
  and 'Banner for active conversation'. New config keys: `notifyMuted`,
  `notifyActiveBanner`, `quietHoursStart`, `quietHoursEnd` (HH:MM,
  wraps midnight).
- **Composer M1.** Internal cursor + motion / deletion bindings:
  Left/Right, Home/Ctrl+A, End/Ctrl+E, Ctrl+W (delete previous word),
  Ctrl+U (delete to line start), Ctrl+K (delete to line end / join),
  Alt+Backspace (delete previous word), Alt+Left/Right (prev/next
  word). Multi-line render (up to 5 lines visible with overflow hint),
  cursor visible at its actual column.
- **Bracketed paste.** The composer toggles CSI `?2004h` while focused
  and parses CSI 200~ / 201~ wrappers (including pastes that straddle
  Bun stdin chunk boundaries) so multi-line pastes preserve their
  newlines instead of triggering one Enter per line.
- **Per-conversation drafts.** Composer drafts are saved to
  `AppState.draftsByConvo` on every keystroke and reseeded when focus
  changes. Send clears the draft; failure restores it for retry.
- **Reactions read path.** `ChatMessage.reactions` is now properly
  typed (`Reaction[]`). Each message renders an aggregated counter line
  (`👍3|❤1|😂2`) with first-seen ordering and a glyph table for
  the documented Microsoft set plus common aliases.
- **Edited / deleted message markers.** Edited messages get a faint
  ' (edited)' suffix when `lastModifiedDateTime` is more than 5s after
  `createdDateTime` (5s grace avoids flagging Graph's server-side
  normalization of fresh sends). Deleted messages render as
  '(message deleted by SenderName · HH:MM)' in italic muted text.
- **In-conversation message search (S1).** `/` from chat / channel
  focus opens an inline search bar at the top of MessagePane. Type to
  filter (case-insensitive across body + sender display name); Enter
  jumps to most recent match; `n` steps through hits with wrap.
  Closes with Esc.
- **Channel threads M1.** New `Focus` kind 'thread'. Press `t` on a
  focused channel root message to open its thread; reads via Graph's
  `/replies` endpoint. The composer routes sends through
  `postChannelReply` when in thread focus. `h` / Esc inside a thread
  returns to the parent channel rather than the chat list.
- **Multi-account M1.** Picking an account in the Accounts modal and
  hitting Enter now switches profiles cleanly: stops the running
  session, wipes account-scoped state via `resetAccountScopedState`,
  flushes the previous profile's cache, hydrates the new profile's
  cache, and brings up a fresh session against it. Settings and
  terminal-focus state survive the switch. Per-profile cache files
  ('messages.<slug>.json') replace the shared 'messages.json' for
  named profiles; the default profile keeps the legacy filename.
- **GitHub Actions CI.** `.github/workflows/ci.yml` runs typecheck +
  test + prettier --check on every push and PR across
  ubuntu-latest × macos-latest. `.github/workflows/release.yml`
  triggers on `v*` tags and builds/uploads release artifacts for
  macOS, Linux, and Windows single-file binaries.
- **Linux build targets.** `scripts/build.sh` accepts
  `bun-linux-x64-modern` and `bun-linux-arm64` and defaults to the
  right one when run on a Linux host.
- `-p` short alias for `--profile` on the CLI.
- `engines.bun` field in `package.json` documenting the >=1.1.0 minimum.
- `noUnusedLocals` and `noUnusedParameters` enabled in `tsconfig.json`.
- Regression test covering tmp-file cleanup when the message-cache
  save fails (`saveMessageCacheNow` rename onto a directory).

### Changed

- **Major poller refactor.** `src/state/poller.ts` shrunk from 888 to
  ~200 lines of pure orchestration. Loops are now factored into
  `src/state/poller/{activeLoop,listLoop,presenceLoop}.ts` plus
  helpers (`teamsAndChannels`, `crossChatMentions`, `hydrateMembers`,
  `loadOlder`, `merge`, `mentions`, `pagePatch`, `chatList`,
  `intervals`, `sleeper`, `memberPresence`).
- **`App.tsx` refactor.** Down from 578 to ~290 lines. `NewChatPrompt`
  moved into its own file; focus-driven side effects extracted into
  hooks (`useTerminalRows`, `useHydrateMembers`, `useClampMessageCursor`);
  zone keymaps extracted into `src/ui/keybinds/` with pure
  testable handler functions.
- Trouter websocket connect timeout is now cleared on `onopen` and
  `onclose` so a delayed timer can no longer fire `close()` on a
  healthy socket. Also documents the rationale behind the
  desktop-shaped `clientDescription` payload sent during registration.
- `bin/teaminal.tsx` shutdown logic moved into a `finally` block so
  exceptions out of `ink.waitUntilExit()` no longer leak background
  tasks (poller loops, trouter websocket, force-availability driver,
  focus tracker, message cache flush).
- Message-cache `saveMessageCacheNow` now `unlinkSync`s the failed
  tmp file instead of overwriting it with empty content. No more
  zero-byte stragglers next to `messages.json` after a save error.

### Fixed

- **Poller test flake.** Long-standing afterEach 5s timeouts in
  `src/state/poller.test.ts` traced to a race in `makeSleeper`: between
  a timer-resolved sleep and the next `sleep()` call, `wake()` was a
  no-op. New `Sleeper.close()` latches a 'closed' flag so subsequent
  sleeps return immediately; `stop()` calls `close()` instead of
  `wake()`. Suite now runs 540/540 in ~2.5s.
- The realtime bridge now also wakes the poller on `reaction-added`
  events, completing the symmetric set with chat-updated / created /
  message-edited / -deleted.
- Stale `TODO: persist later` comment in `src/state/store.ts` (settings
  persistence shipped in 0.6.0).

### Added

- Force-available while terminal focused. teaminal now enables DEC
  focus reporting (CSI `?1004`) and PUTs `forceavailability=Available`
  to `presence.teams.microsoft.com` whenever the terminal window has
  focus, mirroring how the Teams desktop client keeps you Available
  while you're actively using it. The override expires server-side
  after ~5 minutes; the driver refreshes every 4 minutes inside that
  window. On blur the override is left to decay naturally rather than
  cleared (restoring auto-presence would require guessing the user's
  "real" state). New `forceAvailableWhenFocused` config key (default
  `true`) and matching toggle under Settings → "Set Available while
  terminal focused". 401/403/404 from the endpoint disable the driver
  for the session and warn once. Same `PresenceRW` token used for
  presence reads — no new scope.
- Other-user presence dots in the chat list. The presence loop now
  fetches presence for the "other" AAD user in each hydrated 1:1 chat
  (capped at the first 50 to bound cost) and writes them to
  `memberPresence`, so the green/yellow/red dot next to the row matches
  reality. Uses Teams unified presence when available, with a Graph
  `getPresencesByUserId` fallback when the Teams path is unreachable
  for the session. Honors the existing `Show presence in chat list`
  setting — disabling it skips the network call entirely. The realtime
  bridge also seeds `memberPresence` on `presence-changed` pushes for
  previously-unseen users (was previously dropped if the entry didn't
  already exist), so dots light up the moment Trouter delivers an
  update.
- Diagnostics presence row now reflects what teaminal actually uses.
  `probeCapabilities` targets the Teams unified-presence endpoint
  (`presence.teams.microsoft.com`, `aud=presence.teams.microsoft.com`,
  `scp=PresenceRW`) instead of Graph `/me/presence`. In tenants where
  the FOCI Graph token has no `Presence.Read` scope, the runtime path
  works fine but the old probe lit up `presence unavailable 403` —
  diagnostics now agrees with reality. `TeamsPresenceError` 401/403/404
  classify the same way as the Graph variants did.
- Self-presence at cold start without `Presence.Read`. The presence loop
  now prefers the Teams unified-presence endpoint
  (`presence.teams.microsoft.com`) for own presence, which works under
  FOCI tokens whose Graph audience does not carry `Presence.Read`. The
  Teams endpoint is also richer (deviceType, OOO, work-location). Falls
  back to Graph `/me/presence` automatically on a 401/403/404 from the
  Teams call, and never re-tries Teams in the same session after such a
  failure. New optional `useTeamsPresence` config key (default `true`)
  forces the legacy Graph-only path when set to `false` — useful in
  tenants that block the public client from talking to
  `presence.teams.microsoft.com`. Trouter `presence-changed` pushes
  still take precedence over polled values.
- `getToken({ scope })` overload on `src/auth/owaPiggy.ts`. Lets internal
  callers ask for a token with a non-default audience by routing through
  owa-piggy's existing `--scope` flag. Cached separately from the
  default-graph token so concurrent loops with different audiences do
  not fight each other in the in-process cache. The legacy
  `getToken(profile)` string overload is preserved.

### Notes

- No changes to owa-piggy itself were required for this release.
  The Teams-presence path uses the existing `--scope` flag, never
  `--json`, so no rotated refresh tokens are exposed.

## [0.7.2] - 2026-05-04

### Added

- Persistent message cache. Older messages loaded into a chat or channel
  are now written to `${XDG_CACHE_HOME:-~/.cache}/teaminal/messages.json`
  and rehydrated on next launch, so reopening a conversation no longer
  re-fetches pages from Graph. Capped at 200 messages per conversation
  and 100 conversations; optimistic / failed sends are never persisted.
  Pagination cursors (`@odata.nextLink`) and `fullyLoaded` are restored
  too, so "Load older messages" picks up where the previous session left
  off.

### Changed

- Message pane now fills the available terminal height instead of
  capping at 20 rows. Resizing the terminal recomputes the visible row
  count live.
- A subtle `… loading older messages` indicator is shown above the
  message list when an older-history fetch is in flight, even when the
  load-more row itself is scrolled out of view.

### Fixed

- Presence loop no longer hammers Graph with 401s when the owa-piggy
  token does not carry the `Presence.Read` scope. The loop now skips on
  any failed presence capability (previously only `unavailable` / 403
  was handled, while `unauthorized` / 401 from a missing scope kept
  retrying). Own presence is still picked up live from trouter
  `presence-changed` events when the token grants it elsewhere.

- Half-page navigation (`U` / `D`) now responds to lowercase keystrokes
  too. Previously it required Shift, unlike `J` / `K`.

- Accounts modal now lists every owa-piggy profile. The status parser
  previously only recognized the `[profile=name]` header format, so real
  output (`profile:      name`) collapsed into a single `<owa-default>`
  entry and additional profiles were dropped.

### Added

- Real-time transport layer (Option E hybrid): internal event bus,
  trouter WebSocket transport, and realtime bridge that accelerates
  polling on push events.
- Typing indicators in the message pane ("Alice is typing…") powered
  by trouter push events with automatic 8-second expiry.
- Realtime connection state indicator in the header bar (rt:connected/
  reconnecting/error).
- Instant presence updates via trouter push events supplement the 60s
  polling loop.
- New-message push signals wake the poller immediately, reducing active
  chat latency from ~5s to <1s when trouter is connected.

## [0.5.0]

### Added

- Lazy message pagination/cache for active conversations with explicit
  "load older messages" support.
- Unread chat activity tracking, unread/mention counts in the header, and
  bold unread sender previews in the chat list.
- New-chat prompt and search-driven 1:1 chat creation using Microsoft Graph
  people/user search and `POST /chats`.
- Date headers, focused-message navigation, H/J/K/L and U/D message
  movement, and configurable focused-message indicators.
- JSON config persistence for all settings, theme overrides, and managed
  account aliases under `~/.config/teaminal/config.json`.
- Accounts modal for adding valid `owa-piggy status` profiles and removing
  profiles from teaminal's managed account list.
- README platform support, install, build, configuration, keybinding, and
  `owa-piggy` prerequisite documentation.
- Homebrew release guidance with a `teaminal` formula template and exact tap
  update steps in `docs/release.md`.

### Changed

- Header bar now contains profile, tenant, presence, connection, chat count,
  unread counts, capability hints, and last-updated status.
- `chatListDensity: "compact"` now materially changes chat/message layout.
- Message and chat rows use column layout so wrapped lines align under their
  content instead of restarting at column zero.
- `Switch account` menu entry is now `Accounts`.
- Prepared the next minor version metadata as `0.5.0`.

### Fixed

- `scripts/build.sh` now fails early with a clear message for unsupported
  hosts or targets instead of attempting unsupported Bun compile targets.

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
