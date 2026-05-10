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
`https://teams.microsoft.com/api/mt/part/{region}/beta/users/fetch?isMailAddress=true&canBeSmtpAddress=true&enableGuest=true&skypeTeamsInfo=true&includeIBBarredUsers=true&includeDisabledAccounts=true`
with the email(s) as a JSON body array (`["user@domain.tld"]`).
Auth: spaces token via `Authorization: Bearer` (same as
`fetchFederated`; chatsvc-side `/v1/users/ME/*` endpoints are the
ones that want the Skype token via `Authentication`).

Note on endpoint discovery: we tried several `/api/mt/*` variants
before settling on `users/fetch`:

| Endpoint | Result for `kim@damsleth.no` |
|---|---|
| `users/searchUsers?searchTerm=...` (GET) | 400 InvalidUserId - expects an MRI/AAD-id/UPN, not free text |
| `users/{upn}` (GET) | 404 UserNotFound |
| `users/searchV3` (POST) | 405 Method Not Allowed |
| `users/fetchFederated` (POST, email body) | 400 - "UserId should be AD ObjectId" |
| `users/fetch` (POST, email body, `isMailAddress=true`) | 200 + result array (or empty when tenant policy blocks) |
| `users/fetchShortProfile` (POST, email body) | 200 - same shape as `fetch` |

Response is `{ type: ..., value: SkypeUser[] }` or a bare
`SkypeUser[]`; `extractRows()` handles both. Map each entry into the
existing `DirectoryUser` shape so the UI can keep using one type.

### Tenant federation policy

A 200 response with `value: []` does *not* mean the user doesn't
exist. It means the searched user's tenant has not authorised
inbound discovery / chat from the caller's tenant. The `damsleth.no`
test tenant returned empty for every Teams endpoint variant we
tried; this is a tenant policy decision (Teams admin → external
access settings), not a teaminal bug. The plumbing is correct, the
endpoint accepts the request - the upstream just refuses to surface
the user.

If the test for `kim@damsleth.no` fails with "external hits=0" while
the linked-tenant user resolves cleanly, the fix is on the Teams
admin side of the destination tenant, not in teaminal.

Skype response fields we care about:

- `mri` (e.g. `8:orgid:UUID` or `8:live:cid-123`) - the canonical id.
- `displayName`
- `email`
- `userPrincipalName` (when AAD-backed)
- `tenantId` (when AAD-backed)

Map to `DirectoryUser`:

- `id` ← AAD UUID extracted from MRI (the orgid suffix), or the raw
  MRI if not orgid-shaped (consumer accounts).
- `displayName` ← `displayName`
- `userPrincipalName` ← `userPrincipalName ?? email`
- `mail` ← `email`

Open shape questions (validate against a real call - we don't have a
HAR yet for this exact endpoint):

- Does the response come back as `{ value: [...] }` or as a bare
  array? Code handles both.
- What's the failure mode for "no such user"? 200 + empty array, or
  404? Treat both as "no match".

### Module: `src/graph/chats.ts` (extend)

`createOneOnOneChat(myId, otherId)` currently posts to Graph
`/chats`. Graph 403s for users it doesn't know about (unlinked
tenants). When `createOneOnOneChat` 403s with that signature, fall
back to the chatsvc thread-creation path (the same endpoint Teams web
uses for external-tenant 1:1s). Mirror the chatsvc-channel-fallback
shape we already have - the `Authorization` token is the Skype
token, and the body is Skype-shaped.

A simpler tactical option: skip the fallback for v1, and surface a
clear error if Graph rejects. The user can still see the candidate
in the picker and learn that the chat-creation step needs more work.
Keep this as an explicit follow-up in the changelog.

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
