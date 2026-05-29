// Server-side message search via the Microsoft Search API.
//
// POST /search/query with entityTypes: ['chatMessage'] searches the user's
// chat + channel messages tenant-wide — far beyond the locally-cached
// window the in-conversation search (S1) covers. The response is a nested
// value[].hitsContainers[].hits[] structure; parseSearchResponse flattens it
// into ChatMessageSearchHit and is kept pure so it can be tested without the
// network.
//
// Caveats: the Search API is rate-limited more aggressively than the chat
// endpoints (callers debounce), and some tenants disable the chatMessage
// entity type (the query then returns an empty hit set, surfaced as "no
// results" rather than an error).

import { graph } from './client'
import { htmlToText } from '../text/html'
import type { ChatMessageSearchHit } from '../types'

export type SearchMessagesOpts = {
  size?: number
  signal?: AbortSignal
}

const DEFAULT_SIZE = 25

// The Search API wraps matched terms in <c0>…</c0> markers and uses
// <ddd/> for elision. Strip the markers but KEEP their text — htmlToText
// would discard the highlighted word along with its unknown tag, which is
// exactly the term the user searched for.
function cleanSummary(raw: string): string {
  return raw
    .replace(/<ddd\s*\/?>/gi, '…')
    .replace(/<\/?c\d+>/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Body fallback is real message HTML, so htmlToText is the right tool there.
function bodyToText(raw: string | undefined | null): string {
  if (!raw) return ''
  return htmlToText(raw).replace(/\s+/g, ' ').trim()
}

type SearchHit = {
  summary?: string
  resource?: {
    id?: string
    createdDateTime?: string
    chatId?: string | null
    from?: { user?: { displayName?: string | null } | null } | null
    body?: { content?: string | null } | null
  }
}

// Flatten a /search/query response into hits. Defensive against missing
// containers / fields — Graph omits empty levels and varies channel vs chat
// message shapes.
export function parseSearchResponse(json: unknown): ChatMessageSearchHit[] {
  const out: ChatMessageSearchHit[] = []
  const value = (json as { value?: unknown })?.value
  if (!Array.isArray(value)) return out
  for (const entry of value) {
    const containers = (entry as { hitsContainers?: unknown })?.hitsContainers
    if (!Array.isArray(containers)) continue
    for (const container of containers) {
      const hits = (container as { hits?: unknown })?.hits
      if (!Array.isArray(hits)) continue
      for (const hit of hits as SearchHit[]) {
        const resource = hit?.resource
        const messageId = resource?.id
        if (!messageId) continue
        const snippet = (hit.summary ? cleanSummary(hit.summary) : '') || bodyToText(resource?.body?.content)
        out.push({
          messageId,
          chatId: resource?.chatId ?? null,
          snippet,
          createdDateTime: resource?.createdDateTime ?? '',
          senderDisplayName: resource?.from?.user?.displayName ?? null,
        })
      }
    }
  }
  return out
}

export async function searchMessages(
  query: string,
  opts?: SearchMessagesOpts,
): Promise<ChatMessageSearchHit[]> {
  const q = query.trim()
  if (!q) return []
  const json = await graph<unknown>({
    method: 'POST',
    path: '/search/query',
    body: {
      requests: [
        {
          entityTypes: ['chatMessage'],
          query: { queryString: q },
          from: 0,
          size: opts?.size ?? DEFAULT_SIZE,
        },
      ],
    },
    signal: opts?.signal,
  })
  return parseSearchResponse(json)
}
