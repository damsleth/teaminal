// Presence polling loop.
//
// Refreshes /me/presence (Graph) plus, when capable, the Teams unified-
// presence path that returns away/inactive timer state Graph hides.
// Member presence for 1:1 chats is fetched in the same iteration when
// the showPresenceInList setting is on, capped at MEMBER_PRESENCE_LIMIT
// to bound the per-tick fan-out.
//
// teamsPresenceUnreachable latches on hard auth/scope/tenant failures
// so we don't keep slamming a 401/403/404 path every 60s; the next
// teaminal launch retries.

import { getActiveProfile } from '../../graph/client'
import { getMyPresence } from '../../graph/presence'
import { getMyTeamsPresence, TeamsPresenceError } from '../../graph/teamsPresence'
import type { Presence } from '../../types'
import type { AppState, Store } from '../store'
import { backoff, isAbortError, jitter, MEMBER_PRESENCE_LIMIT } from './intervals'
import { fetchMemberPresence } from './memberPresence'
import type { Sleeper } from './sleeper'

export type PresenceLoopDeps = {
  store: Store<AppState>
  sleeper: Sleeper
  intervalMs: number
  isStopped: () => boolean
  reportError: (err: unknown) => void
}

export function makePresenceLoop(deps: PresenceLoopDeps): () => Promise<void> {
  const { store, sleeper, intervalMs, isStopped, reportError } = deps

  return async function run(): Promise<void> {
    let consecutiveErrors = 0
    let teamsPresenceUnreachable = false
    while (!isStopped()) {
      const state = store.get()
      const caps = state.capabilities
      const teamsPresenceEnabled = state.settings.useTeamsPresence !== false
      const useTeams = teamsPresenceEnabled && !teamsPresenceUnreachable
      const useGraph = caps?.presence.ok !== false

      if (!useTeams && !useGraph) {
        // Both paths are off; presence stays whatever the realtime
        // bridge / store seeded.
        await sleeper.sleep(jitter(intervalMs))
        continue
      }

      const presenceAbort = new AbortController()
      let updated = false
      try {
        if (useTeams) {
          try {
            const teams = await getMyTeamsPresence({
              profile: getActiveProfile(),
              signal: presenceAbort.signal,
            })
            if (isStopped()) return
            if (teams) {
              const meId = store.get().me?.id ?? teams.oid
              store.set({
                myPresence: {
                  id: meId,
                  availability: teams.availability as Presence['availability'],
                  activity: teams.activity as Presence['activity'],
                },
              })
              updated = true
            }
          } catch (err) {
            if (isAbortError(err)) {
              // fall through to finally; don't bump errors or fall back.
            } else if (
              err instanceof TeamsPresenceError &&
              (err.status === 401 || err.status === 403 || err.status === 404)
            ) {
              // Hard auth/scope failure or wrong-tenant; stop trying for
              // this session, surface once, and fall through to Graph.
              teamsPresenceUnreachable = true
              reportError(err)
            } else {
              throw err
            }
          }
        }
        if (!updated && useGraph) {
          const myPresence = await getMyPresence({ signal: presenceAbort.signal })
          if (isStopped()) return
          store.set({ myPresence })
        }

        // --- Other-user presence for the chat-list dot ---
        const stateAfterSelf = store.get()
        const wantsMembers = stateAfterSelf.settings.showPresenceInList !== false
        if (wantsMembers && !presenceAbort.signal.aborted) {
          const meId = stateAfterSelf.me?.id
          const oids: string[] = []
          const seen = new Set<string>()
          for (const chat of stateAfterSelf.chats) {
            if (chat.chatType !== 'oneOnOne') continue
            const other = (chat.members ?? []).find((m) => m.userId && m.userId !== meId)
            const id = other?.userId
            if (!id || seen.has(id)) continue
            seen.add(id)
            oids.push(id)
            if (oids.length >= MEMBER_PRESENCE_LIMIT) break
          }
          if (oids.length > 0) {
            try {
              const fetched = await fetchMemberPresence(oids, {
                useTeams,
                useGraph,
                signal: presenceAbort.signal,
              })
              if (isStopped()) return
              if (fetched.size > 0) {
                store.set((s) => {
                  const next = { ...s.memberPresence }
                  for (const [id, p] of fetched) next[id] = p
                  return { memberPresence: next }
                })
              }
            } catch (err) {
              if (!isAbortError(err)) {
                // Don't bump consecutiveErrors: self-presence already
                // succeeded, and we don't want a transient member-
                // presence failure to put the whole loop in backoff.
                reportError(err)
              }
            }
          }
        }

        consecutiveErrors = 0
      } catch (err) {
        if (!isAbortError(err)) {
          consecutiveErrors++
          reportError(err)
        }
      }
      await sleeper.sleep(jitter(backoff(intervalMs, consecutiveErrors)))
    }
  }
}
