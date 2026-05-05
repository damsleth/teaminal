// Per-list-poll fetch of joined teams plus their channel lists.
//
// Per-team channel-list failures are reported but don't poison the
// whole list refresh: the team gets an empty channel list and the loop
// keeps going. Abort signals (focus change, stop()) are re-thrown so
// the caller's outer try/catch can short-circuit cleanly.

import { listChannels, listJoinedTeams } from '../../graph/teams'
import type { Channel } from '../../types'
import type { AppState } from '../store'
import { isAbortError } from './intervals'

export type FetchTeamsResult = {
  teams: AppState['teams']
  channelsByTeam: Record<string, Channel[]>
}

export async function fetchTeamsAndChannels(
  signal: AbortSignal,
  reportError: (err: unknown) => void,
): Promise<FetchTeamsResult> {
  const teams = await listJoinedTeams({ signal })
  if (teams.length === 0) return { teams, channelsByTeam: {} }
  const results = await Promise.all(
    teams.map(async (team): Promise<[string, Channel[]]> => {
      try {
        const channels = await listChannels(team.id, { signal })
        return [team.id, channels]
      } catch (err) {
        if (isAbortError(err)) throw err
        reportError(err)
        return [team.id, []]
      }
    }),
  )
  const channelsByTeam: Record<string, Channel[]> = {}
  for (const [teamId, channels] of results) channelsByTeam[teamId] = channels
  return { teams, channelsByTeam }
}
