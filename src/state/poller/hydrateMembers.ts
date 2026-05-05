// Background member hydration for chats whose /chats listing did not
// include members. /chats with $expand=members is capped at 25 with a
// different schema, so the bulk listing usually omits members; without
// this hydration, every 1:1 chat would render as "(1:1)" until focused.
//
// Runs after each successful list poll. Once a chat is hydrated, its
// members are carried forward via mergeChatMembers, so re-fetching on
// every list poll is wasted work — the `hydrated` set tracks which
// chats we've already issued a getChat($expand=members) call for.

import { getChat } from '../../graph/chats'
import type { Chat } from '../../types'
import type { AppState, Store } from '../store'
import { isAbortError } from './intervals'

const CONCURRENCY = 5

export type HydrateMembersDeps = {
  store: Store<AppState>
  // Set of chat IDs we've already issued a hydration call for (mutated).
  hydrated: Set<string>
  // Hot-stop signal. Gets aborted at stop() time so an in-flight
  // hydration batch returns promptly.
  signal: AbortSignal
  // Read-only flag for the cooperative stop check between batches.
  isStopped: () => boolean
  reportError: (err: unknown) => void
}

export async function hydrateMissingMembers(
  deps: HydrateMembersDeps,
  chats: Chat[],
): Promise<void> {
  const { store, hydrated, signal, isStopped, reportError } = deps
  const targets = chats.filter((c) => {
    if (hydrated.has(c.id)) return false
    if (c.topic) return false // group chat with explicit topic uses topic as label
    if (c.members && c.members.length > 0) return false
    return true
  })
  if (targets.length === 0) return
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    if (isStopped() || signal.aborted) return
    const batch = targets.slice(i, i + CONCURRENCY)
    await Promise.all(
      batch.map(async (chat) => {
        try {
          const full = await getChat(chat.id, { members: true, signal })
          hydrated.add(chat.id)
          if (full.members && full.members.length > 0) {
            store.set((s) => ({
              chats: s.chats.map((c) => (c.id === chat.id ? { ...c, members: full.members } : c)),
            }))
          }
        } catch (err) {
          if (isAbortError(err)) return
          reportError(err)
        }
      }),
    )
  }
}
