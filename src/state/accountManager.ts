// Owns account sessions and their per-profile caches (M2 Phase E).
//
// Still one session at a time. The manager holds the running SessionHandle
// and its force-availability driver, points the poller ref the UI reads at
// the running session's poller, owns the per-profile cache paths with their
// persistence subscription, the one notification drain timer, and the
// switch sequence (stop -> flush -> path swap -> reset -> hydrate -> start).
// Sessions share no process globals, so background accounts (E.4) can run
// beside it.

import { accountRef } from '../account'
import { createGraphClient, type GraphClient } from '../graph/client'
import { debug, warn } from '../log'
import { drainNotifications } from '../notify'
import { accountStore, openAccount, type AccountStore } from './accountStore'
import { runSession, type RunSessionOpts, type SessionHandle } from './bootstrap'
import { startForceAvailabilityDriver, type ForceAvailabilityHandle } from './forceAvailability'
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
  // Manual push reconnect for the running session (diagnostics `r`).
  retryRealtime(): void
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
  // Test seams: the session starter and the force-availability driver.
  startSessionImpl: typeof runSession = runSession,
  startForceDriverImpl: typeof startForceAvailabilityDriver = startForceAvailabilityDriver,
): AccountManager {
  // Seeded/offline mode (tui-test, demos) must neither read nor write the real
  // per-profile caches: fixture data would overwrite ~/.cache/teaminal, and
  // real cached data would leak into deterministic snapshots.
  const seeded = isSeededMode()
  const persistCaches = !seeded
  const pollerHandleRef: PollerHandleRef = { current: null }
  let activeProfile = profile
  let currentSession: SessionHandle | null = null
  // Started with each session (before its bootstrap, so presence goes out
  // right away) and stopped with it.
  let forceDriver: ForceAvailabilityHandle | null = null
  let drainTimer: ReturnType<typeof setInterval> | null = null
  let stopped = false
  // Bumped by every start / switch / stopAll. A bootstrap that resolves after
  // a newer transition began is obsolete: it is stopped, never installed.
  let transition = 0
  // Transitions (stop -> flush -> reset -> hydrate -> kick off the bootstrap)
  // run one at a time on this chain. The bootstrap itself is not on it: a
  // hung runSession must not block a later switch or quitting, so it is
  // superseded through `transition` and its slot handle instead.
  let lifecycle: Promise<unknown> = Promise.resolve()
  function serialize<T>(step: () => T | Promise<T>): Promise<T> {
    const run = lifecycle.then(step)
    lifecycle = run.catch(() => {})
    return run
  }

  let acc: AccountStore = openAccount(store, accountRef(activeProfile), { foreground: true })

  // Hydrate the per-profile caches so the sidebar and message pane show
  // history before the first poll. Failure is silent: the poller refills.
  function hydrate(acc: AccountStore, p: string | null): void {
    try {
      // Names first: merged with (not overwritten by) names seeded from the
      // message/list caches below.
      const names = loadNameCache(getNameCachePath(process.env, p))
      if (Object.keys(names).length > 0) {
        acc.set((s) => ({ nameByUserId: { ...names, ...s.nameByUserId } }))
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
        acc.set((s) => ({
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
        acc.set((s) => ({
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
  if (persistCaches) hydrate(acc, activeProfile)

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
    forceDriver?.stop()
    forceDriver = null
    const session = currentSession
    currentSession = null
    pollerHandleRef.current = null
    if (!session) return
    try {
      await session.stop()
    } catch (err) {
      warn('session: stop failed:', err instanceof Error ? err.message : String(err))
    }
  }

  // Start the slot's force driver and session. Called inside a lifecycle
  // step; the bootstrap comes back boxed so the chain does not wait for it.
  // It resolves once the session is installed, or stopped because a newer
  // transition superseded it (or its slot closed) while it bootstrapped.
  function startSession(
    slot: AccountStore,
    mine: number,
    onFatal: RunSessionOpts['onFatal'],
  ): { bootstrap: Promise<void> } {
    const driver = startForceDriverImpl(slot)
    forceDriver = driver
    const profile = activeProfile
    const bootstrap = (async () => {
      let session: SessionHandle
      try {
        session = await startSessionImpl({ account: slot, profile, onFatal })
      } catch (err) {
        driver.stop()
        if (forceDriver === driver) forceDriver = null
        throw err
      }
      if (stopped || mine !== transition || !slot.isCurrent()) {
        debug('session: discarding a bootstrap superseded by a newer account transition')
        driver.stop()
        await session.stop().catch(() => {})
        return
      }
      currentSession = session
      pollerHandleRef.current = session.poller
      drainTimer ??= setInterval(() => drainNotifications(), 1000)
    })()
    return { bootstrap }
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
    retryRealtime: () => currentSession?.transport?.retry(),

    async start(onFatal) {
      if (seeded) {
        // Deterministic fixture data, no Graph / owa-piggy auth.
        debug('bootstrap: seeded mode active (TEAMINAL_SEED=%s)', process.env.TEAMINAL_SEED)
        applySeededState(acc, activeProfile)
        return
      }
      // Always kicks off the bootstrap, even when a switch or stopAll is
      // already queued behind it: that one supersedes and stops it.
      const mine = ++transition
      const started = await serialize(() => startSession(acc, mine, onFatal))
      await started.bootstrap
    },

    async switchAccount(nextProfile) {
      if (stopped || currentSession?.profile === nextProfile) return
      const mine = ++transition
      const started = await serialize(async () => {
        // A newer switch (or stopAll) was requested while this one waited.
        if (mine !== transition) return null
        // Tear down the running session first so its loops can't write into
        // the about-to-be-reset store.
        await stopSession()
        if (mine !== transition) return null
        // Flush the previous profile's caches before swapping the paths.
        flushCaches()
        // Swap the persistence paths before the reset: the reset fires the
        // cache subscriber, and any write it schedules must target the new
        // profile.
        activeProfile = nextProfile
        messagePath = getMessageCachePath(process.env, activeProfile)
        listPath = getListCachePath(process.env, activeProfile)
        namePath = getNameCachePath(process.env, activeProfile)
        // The reset re-opens the slot with a new generation, so every handle
        // held by async work drops its writes instead of landing in another
        // account (even across A -> B -> A). Done at the reset itself, not at
        // the start of the switch: work begun during teardown still holds the
        // old session's client and must count as stale too.
        resetAccountScopedState(store, accountRef(activeProfile))
        acc = accountStore(store)
        // Seeded mode switches between fixture accounts without a session.
        if (seeded) {
          applySeededState(acc, activeProfile)
          return null
        }
        if (persistCaches) hydrate(acc, activeProfile)
        return startSession(acc, mine, (kind, msg) => {
          warn(`bootstrap: fatal (${kind}): ${msg}`)
        })
      })
      try {
        await started?.bootstrap
      } catch (err) {
        warn('switch: bootstrap failed:', err instanceof Error ? err.message : String(err))
        throw err
      }
    },

    async stopAll() {
      if (stopped) return
      stopped = true
      transition++
      await serialize(async () => {
        unsubscribe()
        // Keep the driver past the session stop: its reset() puts a picked
        // presence back to Available (bounded at 3 s) once caches are safe.
        const driver = forceDriver
        forceDriver = null
        await stopSession()
        flushCaches()
        if (drainTimer) clearInterval(drainTimer)
        drainTimer = null
        if (driver) {
          await driver.reset()
          driver.stop()
        }
      })
    },
  }
}
