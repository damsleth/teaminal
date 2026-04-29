# teaminal — Lightweight Terminal Microsoft Teams Client

## Context

Microsoft Teams' Electron client is heavyweight (~500MB RAM, multi-second cold start). For users who mostly want to read chats and fire off short replies, that's a poor fit for terminal-driven workflows. `teaminal` is a fast TUI alternative that:

- launches in well under a second
- reuses the existing **owa-piggy** auth pipeline (no new OAuth flow, no app registration, no token storage to maintain)
- polls Microsoft Graph for chat/channel updates
- supports 1:1 chats, group chats, joined teams + channels, presence, and notifications in v1

Auth is fully delegated to `owa-piggy` via subprocess. teaminal never sees a refresh token or talks to AAD directly.

## Decisions (locked with user)

| Area | Choice |
|---|---|
| Stack | **Bun + TypeScript + Ink** (React for the terminal) |
| Style | no semicolons, 2-space indent, Prettier defaults (per global CLAUDE.md) |
| Auth | shell out to `owa-piggy token --audience <graph\|teams> [--profile <alias>]` and read only the raw access token |
| Profiles | **pass-through** to owa-piggy; teaminal owns no profile store |
| Freshness | **polling**, adaptive intervals (active chat 5s, background list 30s, presence 60s) |
| MVP scope | chats (read+send), teams+channels (read+send), presence, notifications |
| Real-time (Skype trouter) | out of scope for v1 |
| Webhooks | out of scope (wrong shape for a local TUI) |

## Graph/API Realities to Build Around

Docs checked 2026-04-29 against Microsoft Graph v1.0.

- Do **not** use `owa-piggy token --json`: that prints the full AAD token response, can include a rotated refresh token, and bypasses owa-piggy's own access-token cache. teaminal must only read the raw access token and derive `exp` from the JWT payload locally.
- `GET /chats` ordering supports `lastMessagePreview/createdDateTime desc`, not `lastUpdatedDateTime desc`. Use `$expand=lastMessagePreview` for the hot list.
- Avoid `$expand=members` on the chat hot list. Graph currently caps expanded chat members at 25, so hydrate members lazily for visible/active chats when names or mention IDs are needed.
- Chat messages support `$top <= 50`, descending `$orderby` on `createdDateTime` or `lastModifiedDateTime`, and date filters only when `$filter` matches the `$orderby` property.
- Channel message listing returns root messages only. Replies/threads need separate APIs and remain out of v1.
- Channel message listing supports `$top` but not arbitrary ordering/filtering in v1. Use `@odata.nextLink` for paging.
- Bulk presence (`POST /communications/getPresencesByUserId`) needs `Presence.Read.All`; own presence (`GET /me/presence`) only needs `Presence.Read`. Treat other-user presence as optional and degrade cleanly on 403.
- `GET /me/joinedTeams` does not return host teams for shared channels where the user is only a shared-channel member. Shared-channel discovery can wait until after v1.
- Chat delta for all messages is application-permission only, so delegated owa-piggy auth cannot use it. Polling is intentional for v1.

Reference docs:
- List chats: https://learn.microsoft.com/en-us/graph/api/chat-list?view=graph-rest-1.0
- List chat messages: https://learn.microsoft.com/en-us/graph/api/chat-list-messages?view=graph-rest-1.0
- Send chat messages: https://learn.microsoft.com/en-us/graph/api/chat-post-messages?view=graph-rest-1.0
- List channel messages: https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0
- Send channel messages: https://learn.microsoft.com/en-us/graph/api/channel-post-messages?view=graph-rest-1.0
- List joined teams: https://learn.microsoft.com/en-us/graph/api/user-list-joinedteams?view=graph-rest-1.0
- List channels: https://learn.microsoft.com/en-us/graph/api/channel-list?view=graph-rest-1.0
- Presence: https://learn.microsoft.com/en-us/graph/api/presence-get?view=graph-rest-1.0 and https://learn.microsoft.com/en-us/graph/api/cloudcommunications-getpresencesbyuserid?view=graph-rest-1.0

## Project Layout

```
teaminal/
├── AGENTS.md                  # follow TIRC's AGENTS.md template (purpose, rules, pitfalls, test cmd)
├── README.md
├── package.json               # name, bin, scripts (dev, build, test, typecheck)
├── tsconfig.json              # bun preset, jsx: react-jsx, target esnext
├── bunfig.toml                # bun test config
├── .gitignore                 # already present; extend with node_modules, dist, .env
├── bin/
│   └── teaminal.ts            # shebang + arg parsing + bootstrap
├── src/
│   ├── auth/
│   │   ├── owaPiggy.ts        # subprocess wrapper + in-memory cache
│   │   └── owaPiggy.test.ts
│   ├── graph/
│   │   ├── client.ts          # fetch wrapper: Bearer, 401-retry, 429-backoff
│   │   ├── me.ts              # /me identity used for self/mention detection
│   │   ├── capabilities.ts    # first-run non-mutating Graph capability probe
│   │   ├── chats.ts           # /chats, /chats/{id}/messages
│   │   ├── teams.ts           # /me/joinedTeams, channels, channel messages
│   │   ├── presence.ts        # /me/presence + optional bulk getPresencesByUserId
│   │   └── *.test.ts
│   ├── state/
│   │   ├── store.ts           # tiny pub/sub store (no zustand dep needed)
│   │   └── poller.ts          # adaptive polling loop with backoff
│   ├── ui/
│   │   ├── App.tsx            # root: layout + global keybinds + focus mgmt
│   │   ├── ChatList.tsx       # left pane: unified list of chats + channels
│   │   ├── MessagePane.tsx    # center pane: message timeline with html→text
│   │   ├── Composer.tsx       # bottom: multi-line input (useInput + buffer)
│   │   ├── StatusBar.tsx      # bottom row: profile, presence dot, conn state
│   │   ├── html.ts            # Teams HTML → ANSI/text via a real HTML parser
│   │   └── theme.ts
│   ├── config/
│   │   └── index.ts           # ~/.config/teaminal/config.json (no profile store)
│   ├── notify/
│   │   └── notify.ts          # bell + osascript on @mention
│   ├── log.ts                 # stderr-only debug log behind TEAMINAL_DEBUG
│   └── types.ts               # Chat, ChatMessage, Team, Channel, Presence, Profile
└── scripts/
    └── build.sh               # bun build --compile --target=bun-darwin-arm64 ...
```

## Critical Files & Functions

### `src/auth/owaPiggy.ts` — subprocess wrapper
- `getToken(audience: 'graph' | 'teams', profile?: string): Promise<string>`
  - `Bun.spawn(['owa-piggy', 'token', '--audience', audience, ...(profile ? ['--profile', profile] : [])])`
  - trim stdout as the raw access token; never log it and never request `--json`
  - decode the JWT payload locally to read `exp`, then cache `{ token, exp }` keyed by `(audience, profile ?? '<owa-default>')`
  - return cached token if `exp - now > 60s`, else re-spawn
  - non-zero exit → throw `OwaPiggyError` with stderr trimmed; surface setup/reseed hints for `OWA_REFRESH_TOKEN not set`, `OWA_TENANT_ID not set`, malformed FOCI token, missing profile, and `AADSTS700084`
- `decodeJwtExp(token: string): number`
  - base64url-decode the JWT payload with `Buffer`, parse JSON, require numeric `exp`
  - unit-test with fixture JWTs only; never store real tokens in tests
- `invalidate(audience, profile?)` — clear cache entry (called by graph client on 401)

### `src/graph/client.ts` — HTTP wrapper
- `graph<T>(opts: { method, path, query?, body?, beta?, audience?: 'graph'|'teams' }): Promise<T>`
  - base URL: `https://graph.microsoft.com/{v1.0|beta}`
  - inject `Authorization: Bearer ${getToken(audience ?? 'graph', activeProfile)}`
  - on 401: `invalidate()` once, retry once
  - on 429: read `Retry-After` seconds or HTTP-date, apply jitter, retry up to 3×
  - handle JSON and non-JSON error bodies without throwing while parsing the error
  - paginate via `@odata.nextLink` helper `paginate<T>(opts)`; accept absolute `nextLink` URLs as returned by Graph
- exported error types: `GraphError`, `RateLimitError`

### `src/graph/me.ts`
- `getMe()` — `GET /me?$select=id,displayName,userPrincipalName,mail`
- Store `me.id` and `me.displayName` for self-message and mention detection.

### `src/graph/capabilities.ts`
- `probeCapabilities()` performs non-mutating checks on startup:
  - `/me`
  - `/chats?$top=1&$expand=lastMessagePreview`
  - `/me/joinedTeams`
  - `/me/presence`
- Record feature flags and last error per area; do not probe send endpoints by posting messages.
- Treat 401 as auth failure, 403 as feature unavailable, 429 as transient/backoff.

### `src/graph/chats.ts`
- `listChats(opts?: { top?: number })` — `GET /chats?$expand=lastMessagePreview&$top=50&$orderby=lastMessagePreview/createdDateTime desc`
- `getChat(chatId, opts?: { members?: boolean })` — `GET /chats/{id}?$expand=members` only for visible/active chats
- `listMessages(chatId, opts?: { top?: number, beforeCreatedDateTime?: string })`
  - initial: `GET /chats/{id}/messages?$top=50&$orderby=createdDateTime desc`
  - older page: add `$filter=createdDateTime lt {iso}` and keep the same `$orderby`
  - reverse descending API results before rendering chronological timelines
- `sendMessage(chatId, contentText)` — `POST /chats/{id}/messages` body `{ body: { contentType: 'text', content } }`

### `src/graph/teams.ts`
- `listJoinedTeams()` — `GET /me/joinedTeams`
- `listChannels(teamId)` — `GET /teams/{id}/channels?$select=id,displayName,description,membershipType,isArchived`
- `listChannelMessages(teamId, channelId, opts?)` — `GET /teams/{teamId}/channels/{channelId}/messages?$top=50`
  - render root messages only in v1
  - use returned `@odata.nextLink` for older pages; do not invent unsupported date filters
- `sendChannelMessage(teamId, channelId, contentText)` — `POST .../messages` body `{ body: { contentType: 'text', content } }`

### `src/graph/presence.ts`
- `getMyPresence()` — `GET /me/presence`
- `getPresencesByUserId(ids: string[])` — `POST /communications/getPresencesByUserId`
  - batch at ≤650 IDs
  - on 403, mark `otherUserPresence=false` and keep own presence working

### `src/state/poller.ts`
- `startPoller(store)` runs three async loops:
  - **active**: re-fetches messages for the currently-focused chat/channel every 5s
  - **list**: re-fetches `/chats` and joinedTeams/channel summaries every 30s
  - **presence**: re-fetches own + visible-member presence every 60s when capability flags allow it
- exponential backoff on consecutive errors (cap 60s); resets on first success
- add small jitter to background loops so multiple instances do not align perfectly
- uses `AbortController` so focus-change cancels in-flight active poll cleanly
- suppress duplicate notifications by tracking seen message IDs per conversation

### `src/ui/App.tsx` — layout & keybinds
Three-pane layout (Ink `Box` flex):
```
┌─────────── teaminal ──────────────────────────────────┐
│ Chats          │  # General · Eng                     │
│ > Carl & Nina  │  ─────────────────────────────────── │
│   Crayon Eng   │  09:14  Bjørn   Standup at 10?       │
│   # General    │  09:15  You     ack                  │
│   # Random     │  ...                                  │
│                │                                      │
│ Teams          │                                      │
│   Crayon Eng   │                                      │
│     # General  │                                      │
│     # Random   │                                      │
├────────────────┴──────────────────────────────────────┤
│ > _                                                    │
├───────────────────────────────────────────────────────┤
│ work · Available · 12 chats · polling                 │
└───────────────────────────────────────────────────────┘
```
Global keybinds:
- `j/k` or `↑/↓` — navigate list
- `Enter` — open chat / channel
- `Tab` — focus composer; `Esc` — back to list
- `Ctrl+J` (in composer) — newline; `Enter` — send
- `g g` / `G` — top / bottom of message timeline
- `q` (in list) — quit; `Ctrl+C` always quits
- `r` — force refresh current view
- `/` — filter list

### `src/ui/html.ts` — Teams HTML → ANSI/text
Teams messages are HTML. Use `htmlparser2` + `entities` rather than regex. Handle: `<p>`, `<br>`, `<strong>/<b>`, `<em>/<i>`, `<a href>`, `<at>` mentions, `<emoji>`. Strip everything else. Decode entities. No remote image fetch.

### `src/notify/notify.ts`
- `bell()` — write `\x07` to stdout (terminal bell)
- `system(title, body)` — on darwin, `Bun.spawn(['osascript', '-e', appleScriptNotification(title, body)])`; escape AppleScript strings explicitly and never invoke a shell
- Linux: `notify-send` if available; otherwise no-op
- triggered by poller when a new message in any non-active conversation has a `mentions[].mentioned.user.id` matching self or a textual fallback containing the user's display name

### `src/config/index.ts`
- path: `~/.config/teaminal/config.json` (matches the `~/.config/<tool>/` convention)
- schema: `{ profile?: string, pollIntervals?: { active, list, presence }, notify?: { bell, system }, theme?: 'default' }`
- `loadConfig(): Config` with defaults; never throws on missing file
- profile resolution order: CLI `--profile` > config `profile` > omit `--profile` and let `OWA_PROFILE` / owa-piggy default decide
- teaminal stores only an optional profile alias, never owa-piggy profile data or tokens

### `bin/teaminal.ts`
- parse: `--profile <alias>`, `--debug`, `--version`, `--help`
- `--profile` → set in store, propagated to every owaPiggy call
- import App from `../src/ui/App` and render with Ink

## Build Sequence

1. **Bootstrap & first commit** — `git add . && git commit -m "initial"`, init `bun init`, write `package.json`, `tsconfig.json`, `bunfig.toml`, `AGENTS.md`, `.gitignore` extension, blank `README.md`.
   - runtime deps: `ink`, `react`, `htmlparser2`, `entities`
   - dev deps: `typescript`, `@types/bun`, `@types/react`, `prettier`
   - scripts: `dev`, `build`, `test`, `typecheck`, `format`
2. **Auth layer** — implement `src/auth/owaPiggy.ts` + tests. Manual verify with a redacted smoke script that prints token audience + minutes remaining, never the token itself.
3. **Graph client + `/me`** — `src/graph/client.ts` with Bearer + 401 retry + 429 backoff + pagination; `src/graph/me.ts`; smoke-test `/me`.
4. **Capability probe** — `src/graph/capabilities.ts`; startup should classify auth failure vs feature-unavailable vs transient Graph errors.
5. **Chats** — `src/graph/chats.ts`. Smoke-test: `bun run scripts/list-chats.ts` prints recent chats ordered by last message preview.
6. **Teams + channels** — `src/graph/teams.ts`. Smoke-test: list joined teams + channels with `$select` fields.
7. **Presence** — `src/graph/presence.ts`; own presence required, other-user presence optional on permission failure.
8. **State + poller** — `src/state/store.ts` (minimal pub/sub) and `src/state/poller.ts`.
9. **UI shell** — `App.tsx` with placeholder panes wired to store; render under Ink.
10. **ChatList + MessagePane** — render chats/channels; hydrate visible chat members; open + read.
11. **Composer + send** — wire `sendMessage` / `sendChannelMessage`; optimistic append with failure rollback.
12. **HTML → ANSI/text** + entity decoding via parser.
13. **Notifications** — bell + osascript/notify-send on @mention detected in poller diff.
14. **StatusBar + presence indicator + connection/capability state**.
15. **Polish** — keybinds, `/` filter, `r` refresh, `--help`, error boundary.
16. **Build script** — `scripts/build.sh` for `bun build --compile --target=bun-darwin-arm64 bin/teaminal.ts --outfile dist/teaminal`; smoke-test the binary launches.

## Patterns to Reuse

- `~/.config/<tool>/` config dir convention — mirrors owa-piggy and cal-cli on disk.
- AGENTS.md format from `/Users/damsleth/code/CLI/TIRC/AGENTS.md` (dependency direction, code patterns, known pitfalls, test command). Adapt headings to the Bun/TS context.
- stderr for logs/errors, stdout for data — the same convention as owa-piggy CLI.
- Pass-through `--profile` flag matches owa-piggy CLI shape, so muscle memory transfers.
- Never call `owa-piggy token --json` from teaminal; raw token output preserves the "teaminal never sees refresh tokens" guarantee.

## Verification

End-to-end checks before declaring v1 done:

1. **Auth path**
   - `owa-piggy token --audience graph` works standalone with the user's default profile.
   - `bun run bin/teaminal.ts --profile <alias>` starts without prompting for credentials.
   - Force-expire cached token → next Graph call triggers exactly one re-spawn of owa-piggy.
   - Debug logs and errors never contain access tokens, refresh tokens, or full Authorization headers.

2. **Read path**
   - Open teaminal, see at least 5 recent chats in left pane within 1s of token return.
   - Enter a known chat → last 50 messages render; no HTML tags visible; `<at>` mentions display as `@Name`.
   - Switch to Teams section, open a channel, see channel messages.
   - Wait 30s with new message arriving in another client → background list refresh surfaces it.

3. **Write path**
   - Compose `hello from teaminal` in a 1:1 chat, press Enter, see message echoed in server response within active-poll interval (≤5s); also visible in real Teams client.
   - Same flow in a channel.

4. **Presence + notifications**
   - Status bar shows own presence (Available/Busy/etc.).
   - If `Presence.Read.All` is unavailable, visible-member presence is disabled with a clear non-fatal status.
   - In another client, @-mention the user in a chat teaminal isn't actively viewing → terminal bell rings and macOS notification appears.

5. **Resilience**
   - Disconnect Wi-Fi for 30s → status bar shows "offline", poller backoff visible (no error spam). Reconnect → recovers without restart.
   - Revoke refresh token (`owa-piggy reseed` not yet run after force-revoke) → teaminal surfaces a single clear error pointing at `owa-piggy setup` / `reseed`, not a stack trace.
   - Graph 403s for optional Teams/presence surfaces disable that feature, not the whole app.

6. **Quality gates**
   - `bun test` green
   - `bun x tsc --noEmit` clean (or `bunx tsc`)
   - `bun build --compile` produces a runnable single binary
   - cold-start to first paint under 500ms on the user's machine

## Out of Scope for v1 (parking lot)

- Skype/trouter real-time (api.spaces.skype.com) — defer until polling proves insufficient
- App-permission Graph delta sync — incompatible with delegated owa-piggy auth
- File attachments, reactions, message edits, threads/replies
- Calls / video / screen share
- Emoji picker, GIFs, stickers
- Multi-account live switching inside the TUI
- Webhook subscriptions
