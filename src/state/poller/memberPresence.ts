// Member-presence resolver. Tries the Teams unified-presence endpoint
// first (works on FOCI tokens with aud=presence.teams.microsoft.com /
// scp=PresenceRW), then falls back to Graph getPresencesByUserId if the
// Teams path is disabled or unreachable for the session. Returns a
// partial map: any user id missing from the result simply has no dot.

import { getActiveProfile } from '../../graph/client'
import { getPresencesByUserId } from '../../graph/presence'
import { getTeamsPresenceByOid } from '../../graph/teamsPresence'
import type { Presence } from '../../types'

export type FetchMemberPresenceOpts = {
  useTeams: boolean
  useGraph: boolean
  signal: AbortSignal
}

export async function fetchMemberPresence(
  oids: string[],
  opts: FetchMemberPresenceOpts,
): Promise<Map<string, Presence>> {
  const out = new Map<string, Presence>()
  if (oids.length === 0) return out
  if (opts.useTeams) {
    const teams = await getTeamsPresenceByOid(oids, {
      profile: getActiveProfile(),
      signal: opts.signal,
    })
    for (const [oid, entry] of teams) {
      out.set(oid, {
        id: oid,
        availability: entry.availability as Presence['availability'],
        activity: entry.activity as Presence['activity'],
      })
    }
    return out
  }
  if (opts.useGraph) {
    const list = await getPresencesByUserId(oids, { signal: opts.signal })
    for (const p of list) out.set(p.id, p)
  }
  return out
}
