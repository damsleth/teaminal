# External user search & federated chat creation

## Problem

teaminal's "new chat" prompt searches users via Microsoft Graph
(`/me/people` + `/users`). That surfaces:

1. Users in the current tenant.
2. Users in tenants with an active B2B link to the current tenant
   (they appear in `/users` as guest accounts).

It does **not** surface:

3. Users in unlinked tenants. e.g. searching for `kim@damsleth.no` from
   a `softwareone.com` account returns 0 results because `damsleth.no`
   has no B2B trust with `softwareone.com`.

Teams web *can* start chats with these users. The endpoint it uses is
not Graph - it's the chatsvc-side "external user search":

```
GET https://teams.microsoft.com/api/mt/{region}/beta/users/searchUsers?searchTerm=<email>
```

This walks the federated identity graph, returns candidates with their
canonical AAD object id (or "tenant-less" 8:orgid: MRI), and Teams
follows up with `fetchFederated` + `chats` create.

## Goals

- Allow starting a chat with a user in a fully external tenant (no B2B
  link), e.g. `kim@damsleth.no`.
- Don't change behaviour for in-tenant / B2B-linked searches - those
  must still flow through Graph (faster, richer profile data).
- Don't fire the external endpoint on every keystroke - it's slower
  than Graph search and Teams web rate-limits the path.

## Non-goals

- Inviting a brand-new user (the Azure AD B2B "send invitation" flow).
  That's a different endpoint with explicit consent UX.
- Channel guest invites.
- Cross-tenant presence (separate scopes / endpoints).

## Design

### Trigger: search-as-you-type stays Graph-only

The user's typing produces continuous `searchChatUsers(query)` calls.
Those continue to hit only Graph. No external lookups during typing -
keeps the latency profile and avoids burning the chatsvc rate limit.

### Trigger: on Enter, fall back if Graph found nothing

When the user presses **Enter** in the new-chat prompt and:

- the typed query looks like an email (`name@domain.tld`), and
- Graph returned 0 candidates that match exactly,

teaminal calls `searchExternalUsers(email)`. If that returns a match,
the user lands on the same "select user → create chat" UX as for an
in-tenant hit. If it also returns 0, we fall back to the existing
"Create chat with X" synthetic-row behaviour (which today fails for
unlinked tenants but at least surfaces the search miss explicitly).

### Module: `src/graph/teamsExternalSearch.ts` (new)

```ts
export type ExternalSearchOpts = {
  profile?: string
  region?: string  // 'emea' default
  signal?: AbortSignal
}

export async function searchExternalUsers(
  searchTerm: string,
  opts?: ExternalSearchOpts,
): Promise<DirectoryUser[]>
```

POSTs to
`https://teams.microsoft.com/api/mt/part/{region}/beta/users/searchV2?includeDLs=true&enableGuest=true&includeBots=true&includeMTOUsers=true&includeChats=false&includeChannels=false&includeTeams=false&skypeTeamsInfo=true&source=newChat`
with the email/UPN as a bare JSON-string body (`"user@domain.tld"`).
Auth: spaces token via `Authorization: Bearer` (same as
`fetchFederated`; chatsvc-side `/v1/users/ME/*` endpoints are the
ones that want the Skype token via `Authentication`).

Note on endpoint discovery: we walked through several `/api/mt/*`
variants and one Substrate variant before settling on `searchV2`,
guided by a HAR capture of Teams web doing the equivalent action.

| Endpoint | Result |
|---|---|
| `users/searchUsers?searchTerm=...` (GET) | 400 - expects an MRI/AAD-id/UPN, not free text |
| `users/{upn}` (GET) | 404 UserNotFound |
| `users/searchV3` (POST) | 405 Method Not Allowed |
| `users/fetchFederated` (POST, email body) | 400 - "UserId should be AD ObjectId" |
| `users/fetch` (POST, email body, `isMailAddress=true`) | 200 + result array but never surfaced unlinked-tenant users in our tenant |
| `users/fetchShortProfile` (POST, email body) | same as `fetch` |
| Substrate `search/api/v1/suggestions?scenario=peoplepicker.newChat` | 200 - returns IndexedDB-backed cache results, never live-resolves unknown externals |
| `users/searchV2` (POST, JSON-string body) | **chosen** - 200 + results for in-tenant + B2B-linked + cached cross-tenant |

Response is `{ type, value: SearchUser[] }`; map each entry into the
existing `DirectoryUser` shape so the UI can keep using one type.

### Tenant federation policy

`searchV2` returning `value: []` does *not* always mean the user
doesn't exist. Microsoft's search is fundamentally bounded by:

1. The destination tenant's external-access policy (Teams admin →
   external access settings) must allow inbound discovery from the
   caller's tenant.
2. The user must be in *some* directory the caller's tenant can
   read - either the caller's own AAD, a B2B-linked tenant's AAD,
   or a cached entry from a prior interaction (Teams' IndexedDB).

For genuinely unlinked tenants where no prior interaction exists,
neither `searchV2` nor `users/fetch` will surface the user - we
confirmed this by capturing a HAR of Teams web opening a chat with
`kim@damsleth.no`: `searchV2` returned empty in that capture too.
Teams web only succeeded because it had the user's AAD object id
cached locally from previous sessions.

For that scenario, teaminal lets the user paste the AAD object id
directly into the new-chat prompt - if the input matches the UUID
pattern, we treat it as the peer's id and proceed straight to chat
creation. The peer's OID can be obtained from any existing thread
id (the `19:selfOid_otherOid@unq.gbl.spaces` shape), from the peer
themselves, or from a prior Teams web session.

### Module: `src/graph/chats.ts` + `src/graph/teamsFederation.ts` (extended)

`createOneOnOneChat(myId, otherId)` posts to Graph `/chats` first.
When Graph rejects (403/404 - the cross-tenant Chat.Create scope is
not in the FOCI-issued token), we fall back to a chatsvc create:

```
POST https://teams.microsoft.com/api/chatsvc/{region}/v1/threads
Authentication: skypetoken=<token>
Body: {
  "members": [
    { "id": "8:orgid:<selfOid>", "role": "Admin" },
    { "id": "8:orgid:<otherOid>", "role": "Admin" }
  ],
  "properties": {
    "threadType": "chat",
    "fixedRoster": true,
    "uniquerosterthread": true
  }
}
```

This is the canonical Teams-web path (verified via HAR). It returns
201 + a `Location` header containing the canonical
`19:selfOid_otherOid@unq.gbl.spaces` thread id. The fallback only
triggers when Graph rejects, so in-tenant chats keep using the
richer Graph shape.

### NewChatPrompt UX

```
1. User types `kim@damsleth.no`.
2. Graph search runs as the user types; returns 0.
3. The synthetic "Create chat with kim@damsleth.no" row appears
   under the empty list.
4. User presses Enter on that row.
5. Before calling createOneOnOneChat-with-email, we try
   searchExternalUsers(email):
   - If hit: replace the synthetic row with the resolved candidate,
     bump the cursor, refocus the prompt. User can confirm with
     Enter.
   - If miss: keep the synthetic row, fall through to existing
     create flow (and let it fail / proceed naturally).
6. State during the lookup: a single-line "looking up
   kim@damsleth.no externally..." status under the list, so the
   user knows we're not just hung.
```

A simpler v1: skip the "land on candidate then re-confirm" step and
just create the chat directly with the resolved id once external
search hits. That's a single Enter, no extra confirmation. We can
still surface the resolved displayName in a one-line confirmation
toast / event.

### Caching

Cache external-search results by lowercased query string for the
session, with a 5-minute TTL. Repeat lookups for the same email
should be free.

### Telemetry

`recordEvent('graph', 'info', `external user search: term=${maskEmail} hits=${n}`)`
on each call so the network panel surfaces what teaminal is doing.

### Failure modes & their visible behaviour

| Case | Behaviour |
|---|---|
| Graph search hits | Existing flow. External search not called. |
| Graph search misses, external search hits | Pick up the chat creation flow with the resolved AAD id. |
| Graph search misses, external search misses | Synthetic-row create proceeds (likely fails with a clear error). |
| External search returns 401 | Surface AAD code + body excerpt to network panel; treat as miss. |
| External search returns 429 | Same; treat as miss; user can retry. |
| Skype-token exchange fails | Treat as miss; record the failure once per session. |

## Implementation order

1. Add `searchExternalUsers` + a unit test for the response-shape
   mapping. (No real HTTP - mock the transport.)
2. Wire into `NewChatPrompt` Enter handler. Add an in-flight status
   indicator.
3. Add an e2e test: external lookup for `kim@damsleth.no` returns a
   candidate. Read-only by default.
4. Add e2e CRUD tests (mutating-gated) that:
   - Resolve `kim@damsleth.no` via external search.
   - Create a 1:1 chat.
   - Send a message.
   - Read it back.
   - Delete the message.
5. If chat-creation Graph 403s for unlinked tenants, add the chatsvc
   thread-create fallback in a follow-up commit.

## Risks

- **Undocumented endpoint.** Microsoft can change the response shape
  or rate-limit policy without notice. We mitigate by reading and
  parsing defensively, and by keeping the change isolated behind one
  module.
- **Skype token cost.** We already exchange Skype tokens for chatsvc
  channel reads; the external-search reuses the cached token, no new
  exchange.
- **Privacy.** External searches go to Microsoft with the searched
  email. That's identical to what Teams web does, so no new privacy
  surface beyond the Teams baseline.
