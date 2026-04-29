# AGENTS.md - AI Agent Guidelines for teaminal

## Project Overview

teaminal is a lightweight terminal Microsoft Teams client written in TypeScript. Bun runtime, Ink for terminal UI (React), Microsoft Graph for data, owa-piggy subprocess for auth. See `.plans/teaminal.md` for the full design contract.

## Module Responsibilities

| Module | Purpose | Key Files |
|---|---|---|
| `src/auth` | owa-piggy subprocess wrapper, in-process token cache | `owaPiggy.ts` |
| `src/graph` | Microsoft Graph HTTP client + per-resource calls | `client.ts`, `me.ts`, `chats.ts`, `teams.ts`, `presence.ts`, `capabilities.ts` |
| `src/state` | Pub/sub store + adaptive polling loops | `store.ts`, `poller.ts` |
| `src/ui` | Ink components + HTML→ANSI rendering + keybinds | `App.tsx`, `ChatList.tsx`, `MessagePane.tsx`, `Composer.tsx`, `StatusBar.tsx`, `html.ts` |
| `src/config` | Shell-style key=value config loader | `index.ts` |
| `src/notify` | Terminal bell + system notifications | `notify.ts` |
| `bin` | CLI entry point | `teaminal.ts` |

## Architecture Rules

1. **Dependency direction:** `bin/` → `src/ui/` → `src/state/` → `src/graph/` → `src/auth/`. Lower layers never import upward. `src/auth/` has no dependencies on graph/state/ui.
2. **Polling, not pushing:** All data freshness comes from `src/state/poller.ts`. UI components never call `src/graph/*` directly; they read from the store.
3. **Auth boundary:** Only `src/auth/owaPiggy.ts` spawns subprocesses. Only `src/graph/client.ts` injects `Authorization` headers.

## Code Patterns

### Do This

```ts
// Type-only imports (verbatimModuleSyntax is on)
import type { Chat, ChatMessage } from '../types'

// Route Graph calls through the wrapper for 401/429 handling
const chats = await graph<{ value: Chat[] }>({
  method: 'GET',
  path: '/chats',
  query: { $expand: 'lastMessagePreview', $top: '50' },
})

// Cancel in-flight work on focus change
const ctrl = new AbortController()
fetch(url, { signal: ctrl.signal })
```

### Don't Do This

```ts
// BAD: --json leaks rotated refresh tokens
Bun.spawn(['owa-piggy', 'token', '--json', '--audience', 'graph'])

// BAD: bypass the wrapper - skips 401 retry, 429 backoff, token injection
await fetch('https://graph.microsoft.com/v1.0/chats', { headers: { Authorization: `Bearer ${token}` } })

// BAD: log auth secrets
console.log('Authorization:', req.headers.Authorization)

// BAD: regex-parse Teams HTML messages
content.replace(/<[^>]+>/g, '')  // breaks on <at> mentions and entities
```

## Known Pitfalls

1. **`owa-piggy token --json` leaks the rotated refresh token** from every FOCI exchange. Always use default-mode stdout (raw access token only).
2. **`/chats` ordering** is `lastMessagePreview/createdDateTime desc`. `lastUpdatedDateTime desc` is undocumented and unreliable.
3. **`$expand=members` is capped at 25** on the chat hot list. Hydrate members lazily for visible/active chats only.
4. **Channel message listing** supports `$top` but no useful `$orderby`/`$filter` under delegated auth. Page via `@odata.nextLink` only.
5. **Other-user presence** requires `Presence.Read.All`. On 403, set `otherUserPresence=false` and keep `/me/presence` working.
6. **No textual self-mention fallback.** Short display names ("Carl", "Nina") false-positive on unrelated text. Match strictly on `mentions[].mentioned.user.id === me.id`.
7. **Notification scope is chats + active channel only** in v1. There is no efficient way to detect mentions in non-active channels under delegated auth.
8. **Seed the seen-message-ID set on startup** — otherwise the first poll after launch notifies on every existing message.
9. **`bun init` writes a tsconfig with `verbatimModuleSyntax: true`** — type-only imports must use `import type`, not bare `import`.

## Testing

- `*.test.ts` co-located with the source file (e.g. `src/auth/owaPiggy.test.ts`)
- Run: `bun test`
- JWT and HTTP-response fixtures only — never put real tokens or real account IDs in tests
- Test boundaries: token expiry edge cases, 401-then-retry, 429 with `Retry-After`, AppleScript escaping

## Commands

```bash
bun install              # install deps
bun run dev              # run from source
bun test                 # tests
bun run typecheck        # tsc --noEmit
bun run format           # prettier
bun run build            # compiled binary at dist/teaminal
```

## File Conventions

- No semicolons, 2-space indent, Prettier defaults (per global CLAUDE.md)
- `import type { ... }` for type-only imports
- Errors export from their module: `OwaPiggyError`, `GraphError`, `RateLimitError`
- stdout = data, stderr = logs/errors. Debug log gated behind `TEAMINAL_DEBUG`.
- Never log access tokens, refresh tokens, or full `Authorization` headers - even under `TEAMINAL_DEBUG`.
- Public API per module via `index.ts` re-exports if/when needed.

## When Modifying

1. **Adding a Graph call:** add to the relevant `src/graph/*.ts`, route through `graph<T>()` so it inherits 401 retry, 429 backoff, and pagination.
2. **Adding a keybind:** edit `src/ui/App.tsx` (`useInput` handler) and update the keybinds table in README.
3. **Adding a config key:** edit `src/config/index.ts`, append to the recognized-keys list, document it in README.
4. **Adding a poll loop:** edit `src/state/poller.ts`. Honor jitter, AbortController, and the seen-set conventions.

## Performance

- In-process token cache (`src/auth/owaPiggy.ts`) avoids subprocess spawn cost on the 5s active poll
- Background loops jitter so concurrent teaminal instances do not align perfectly
- `AbortController` cancels active-chat fetches on focus change
- Chat member hydration is lazy (visible/active chats only)
- Cold-start target: first paint of the UI shell under 500ms; data fills in async
