// Owns account sessions and their per-profile caches (M2 Phase E).
//
// E.1: still one session at a time. The manager holds what bin/teaminal.tsx
// used to: the running SessionHandle, the poller ref the UI reads, the
// per-profile cache paths with their persistence subscriptions, and the
// switch sequence (stop -> flush -> path swap -> reset -> hydrate -> start).
// Concurrent sessions (background accounts) build on this in E.2/E.3.

import { accountRef } from '../account'
import { createGraphClient, type GraphClient } from '../graph/client'
import { debug, warn } from '../log'
import { runSession, type RunSessionOpts, type SessionHandle } from './bootstrap'
import {
  flushListCache,
  getListCachePath,
  loadListCache,
  scheduleListCacheSave,
} from './listCachePersistence'
import {
  flushMessageCache,
  getMessageCachePath,
  loadMessageCache,
  scheduleMessageCacheSave,
} from './messageCachePersistence'
import {
  flushNameCache,
  getNameCachePath,
  loadNameCache,
  scheduleNameCacheSave,
} from './nameCachePersistence'
import { indexNamesFromChats, indexNamesFromMessages } from './nameIndex'
import type { PollerHandleRef } from './poller'
import { applySeededState, isSeededMode } from './seedFixtures'
import {
  audienceFromRouting,
  messagesFromCaches,
  resetAccountScopedState,
  routingForAccount,
  type AppState,
  type Store,
} from './store'

export type AccountManager = {
  // The App reads ref.current inside event handlers, so it sees the
  // assignment without a re-render.
  readonly pollerHandleRef: PollerHandleRef
  activeProfile(): string | null
  // The running session's client; before one exists (seeded mode, the
  // auth-expired modal) a client bound to the selected profile.
  client(): GraphClient
  // First session (or fixture data in seeded mode). Throws what runSession
  // throws; the caller decides how to surface it.
  start(onFatal: RunSessionOpts['onFatal']): Promise<void>
  switchAccount(profile: string | null): Promise<void>
  // Stop the session, detach cache subscriptions, flush caches. Idempotent.
  stopAll(): Promise<void>
}

export function createAccountManager(
  store: Store<AppState>,
  profile: string | null,
): AccountManager {
  // Seeded/offline mode (tui-test, demos) must neither read nor write the real
  // per-profile caches: fixture data would overwrite ~/.cache/teaminal, and
  // real cached data would leak into deterministic snapshots.
  const seeded = isSeededMode()
  const persistCaches = !seeded
  const pollerHandleRef: PollerHandleRef = { current: null }
  let activeProfile = profile
  let currentSession: SessionHandle | null = null
  let stopped = false

  store.set({ account: accountRef(activeProfile) })

  // Hydrate the per-profile caches so the sidebar and message pane show
  // history before the first poll. Failure is silent: the poller refills.
  function hydrate(p: string | null): void {
    try {
      // Names first: merged with (not overwritten by) names seeded from the
      // message/list caches below.
      const names = loadNameCache(getNameCachePath(process.env, p))
      if (Object.keys(names).length > 0) {
        store.set((s) => ({ nameByUserId: { ...names, ...s.nameByUserId } }))
        debug(`bootstrap: hydrated ${Object.keys(names).length} cached display names`)
      }
    } catch (err) {
      warn(
        'bootstrap: hydrate name cache failed:',
        err instanceof Error ? err.message : String(err),
      )
    }
    try {
      const persisted = loadMessageCache(getMessageCachePath(process.env, p))
      if (Object.keys(persisted).length > 0) {
        const messages = messagesFromCaches(persisted)
        store.set((s) => ({
          messageCacheByConvo: persisted,
          messagesByConvo: messages,
          // Seed the name index from cached senders so 1:1 / group labels
          // resolve real names before the first poll re-fetches messages.
          nameByUserId: indexNamesFromMessages(s.nameByUserId, Object.values(messages).flat()),
        }))
        debug(`bootstrap: hydrated ${Object.keys(persisted).length} cached conversations`)
      }
    } catch (err) {
      warn(
        'bootstrap: hydrate message cache failed:',
        err instanceof Error ? err.message : String(err),
      )
    }
    try {
      const list = loadListCache(getListCachePath(process.env, p))
      if (list) {
        store.set((s) => ({
          chats: list.chats,
          teams: list.teams,
          channelsByTeam: list.channelsByTeam,
          nameByUserId: indexNamesFromChats(s.nameByUserId, list.chats),
        }))
        debug(`bootstrap: hydrated ${list.chats.length} chats / ${list.teams.length} teams`)
      }
    } catch (err) {
      warn(
        'bootstrap: hydrate list cache failed:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }
  if (persistCaches) hydrate(activeProfile)

  // Persist caches on store changes (debounced inside each scheduler). Paths
  // track the active profile and are swapped before a switch's reset. Empty
  // values are the wiped post-switch / hard-refresh state; writing them would
  // clobber the profile's cache before the poller refills it.
  let messagePath = getMessageCachePath(process.env, activeProfile)
  let listPath = getListCachePath(process.env, activeProfile)
  let namePath = getNameCachePath(process.env, activeProfile)
  let last = store.get()
  const unsubscribe = store.subscribe((s) => {
    const prev = last
    last = s
    if (!persistCaches) return
    if (
      s.messageCacheByConvo !== prev.messageCacheByConvo &&
      Object.keys(s.messageCacheByConvo).length > 0
    ) {
      scheduleMessageCacheSave(s.messageCacheByConvo, undefined, messagePath)
    }
    if (
      (s.chats !== prev.chats || s.teams !== prev.teams) &&
      (s.chats.length > 0 || s.teams.length > 0)
    ) {
      scheduleListCacheSave(
        { chats: s.chats, teams: s.teams, channelsByTeam: s.channelsByTeam },
        undefined,
        listPath,
      )
    }
    if (s.nameByUserId !== prev.nameByUserId && Object.keys(s.nameByUserId).length > 0) {
      scheduleNameCacheSave(s.nameByUserId, undefined, namePath)
    }
  })

  function flushCaches(): void {
    for (const flush of [flushMessageCache, flushListCache, flushNameCache]) {
      try {
        flush()
      } catch {}
    }
  }

  async function stopSession(): Promise<void> {
    const session = currentSession
    currentSession = null
    if (!session) return
    try {
      await session.stop()
    } catch (err) {
      warn('session: stop failed:', err instanceof Error ? err.message : String(err))
    }
  }

  function startSession(onFatal: RunSessionOpts['onFatal']): Promise<SessionHandle> {
    return runSession({ store, profile: activeProfile, pollerHandleRef, onFatal })
  }

  return {
    pollerHandleRef,
    activeProfile: () => activeProfile,
    client: () =>
      currentSession?.client() ??
      createGraphClient({
        account: accountRef(activeProfile),
        ...audienceFromRouting(routingForAccount(store.get().settings, activeProfile)),
      }),

    async start(onFatal) {
      if (seeded) {
        // Deterministic fixture data, no Graph / owa-piggy auth.
        debug('bootstrap: seeded mode active (TEAMINAL_SEED=%s)', process.env.TEAMINAL_SEED)
        applySeededState(store, activeProfile)
        return
      }
      currentSession = await startSession(onFatal)
    },

    async switchAccount(nextProfile) {
      if (currentSession?.profile === nextProfile) return
      // Tear down the running session first so its loops can't write into
      // the about-to-be-reset store.
      await stopSession()
      // Flush the previous profile's caches before swapping the paths.
      flushCaches()
      // Swap the persistence paths before the reset: the reset fires the cache
      // subscriber, and any write it schedules must target the new profile.
      activeProfile = nextProfile
      messagePath = getMessageCachePath(process.env, activeProfile)
      listPath = getListCachePath(process.env, activeProfile)
      namePath = getNameCachePath(process.env, activeProfile)
      // The reset bumps store.accountGeneration, so every accountStore() handle
      // held by async work drops its writes instead of landing in another
      // account (even across A -> B -> A). Bumped at the reset itself, not at
      // the start of the switch: work begun during teardown still holds the
      // old session's client and must count as stale too.
      resetAccountScopedState(store, accountRef(activeProfile))
      // Seeded mode switches between fixture accounts without a session.
      if (seeded) {
        applySeededState(store, activeProfile)
        return
      }
      if (persistCaches) hydrate(activeProfile)
      try {
        currentSession = await startSession((kind, msg) => {
          warn(`bootstrap: fatal (${kind}): ${msg}`)
        })
      } catch (err) {
        warn('switch: bootstrap failed:', err instanceof Error ? err.message : String(err))
        throw err
      }
    },

    async stopAll() {
      if (stopped) return
      stopped = true
      unsubscribe()
      await stopSession()
      flushCaches()
    },
  }
}
