// Presence endpoints.
//
// /me/presence needs Presence.Read; bulk getPresencesByUserId needs
// Presence.Read.All. Treat other-user presence as optional - if Graph
// 403s the bulk call, the StatusBar still shows own presence and chat
// member dots simply go unrendered.

import { graph } from './client'
import type { Presence } from '../types'

const BULK_BATCH_LIMIT = 650

type CollectionResponse<T> = { value: T[] }

export type GetMyPresenceOpts = {
  signal?: AbortSignal
}

export async function getMyPresence(opts?: GetMyPresenceOpts): Promise<Presence> {
  return graph<Presence>({
    method: 'GET',
    path: '/me/presence',
    signal: opts?.signal,
  })
}

export type GetPresencesByUserIdOpts = {
  signal?: AbortSignal
}

// Looks up presence for an arbitrary list of AAD user IDs. Graph caps each
// POST body at 650 IDs; this helper chunks transparently and concatenates
// the results. Empty input is a no-op (no HTTP call), which simplifies the
// caller's "fetch presence for currently visible chat members" loop.
export async function getPresencesByUserId(
  ids: string[],
  opts?: GetPresencesByUserIdOpts,
): Promise<Presence[]> {
  if (ids.length === 0) return []
  const out: Presence[] = []
  for (let i = 0; i < ids.length; i += BULK_BATCH_LIMIT) {
    const batch = ids.slice(i, i + BULK_BATCH_LIMIT)
    const res = await graph<CollectionResponse<Presence>>({
      method: 'POST',
      path: '/communications/getPresencesByUserId',
      body: { ids: batch },
      signal: opts?.signal,
    })
    out.push(...res.value)
  }
  return out
}
