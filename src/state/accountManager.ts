// Owns account sessions and their per-profile caches (M2 Phase E).
//
// Every running account has a slot here: its store handle, session, force-
// availability driver, cache paths and last-persisted refs. The manager
// points the poller ref the UI reads at the foreground slot's poller, runs
// the one persistence subscription (one comparison per slot) and the one
// notification drain timer.
//
// Single mode (the default, or --profile): one slot at a time. A switch is
// stop -> flush -> reset -> hydrate -> start; the last request wins.
//
// Concurrent mode (concurrentAccounts, M2 E.4): one slot per configured
// account. The foreground starts first, the others one at a time after it;
// a switch is an instant foreground swap. An account that fails to start
// keeps its slot with conn authError / offline and never exits the process.

import { accountRef, type AccountId, type AccountRef } from '../account'
import { isRefreshExpiredError } from '../auth/owaPiggy'
import { createGraphClient, type GraphClient } from '../graph/client'
import { debug, warn } from '../log'
import { drainNotifications } from '../notify'
import {
  accountStore,
  closeAccount,
  openAccount,
  setForeground,
  type AccountStore,
} from './accountStore'
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
import { accountRowKey, unifiedSidebar } from './selectables'
import {
  accountSlice,
  audienceFromRouting,
  messagesFromCaches,
  resetAccountScopedState,
  routingForAccount,
  type AccountSlice,
  type AppState,
  type Settings,
  type Store,
} from './store'

export type AccountManager = {
  // The App reads ref.current inside event handlers, so it sees the
  // assignment without a re-render.
  readonly pollerHandleRef: PollerHandleRef
  activeProfile(): string | null
  // The foreground session's client; before one exists (seeded mode, the
  // auth-expired modal) a client bound to the foreground profile.
  client(): GraphClient
  // Same, for any open account.
  clientFor(id: AccountId): GraphClient
  // Manual push reconnect for the foreground session (diagnostics `r`).
  retryRealtime(): void
  // Accounts with a running session, in configured order.
  running(): AccountRef[]
  // First session(s), or fixture data in seeded mode. Single mode throws
  // what runSession throws; concurrent mode never throws and resolves once
  // the foreground's start settled or its head start ran out, whichever is
  // first (the others start after that; the foreground start keeps going).
  start(onFatal: RunSessionOpts['onFatal']): Promise<void>
  // Single mode: tear down and start `profile`. Concurrent mode: start it
  // if it has no session, swap it to the foreground at once, then wait for
  // that start; throws when it fails (the slot stays, marked failed).
  switchAccount(profile: string | null): Promise<void>
  // Concurrent mode: swap an open account to the foreground (throws when
  // it is not open). restoreUi: false keeps the list cursor and filter
  // (opening a row of another account's section in the unified sidebar).
  setForeground(profile: string, opts?: { restoreUi?: boolean }): void
  // Concurrent mode: start an account again that has no session, or whose
  // running session reports authError / offline.
  retry(profile: string): Promise<void>
  // Concurrent mode: open and start added accounts, stop and close removed
  // ones. No-op in single mode.
  reconcile(): Promise<void>
  // Stop every session, detach cache subscriptions, flush caches. Idempotent.
  stopAll(): Promise<void>
}

// Product contract 1: concurrent iff the flag is on, no --profile was given
// and at least one account is configured. Decided once, at startup.
export function concurrentMode(settings: Settings, cliProfile: string | undefined): boolean {
  return settings.concurrentAccounts && !cliProfile && settings.accounts.length > 0
}

type Persisted = Pick<AccountSlice, 'messageCacheByConvo' | 'chats' | 'teams' | 'nameByUserId'>

type Slot = {
  ref: AccountRef
  profile: string | null
  acc: AccountStore
  session: SessionHandle | null
  // Started with the session (before its bootstrap, so presence goes out
  // right away) and stopped with it.
  driver: ForceAvailabilityHandle | null
  // Concurrent mode: bumped by every start, so a superseded attempt's
  // bootstrap or failure is ignored. 0 = never started.
  attempt: number
  // Concurrent mode: the pending start; resolves to its failure or null.
  starting: Promise<Error | null> | null
  // Concurrent mode: why the last start (or the running session) failed;
  // shown again when the account is swapped to the foreground.
  failure: string | null
  hydrated: boolean
  // Resolved when the slot is removed, so a wait on its start (the
  // background queue) is released even if that start hangs.
  removed: Promise<void>
  remove: () => void
  paths: { message: string; list: string; name: string }
  last: Persisted
}

// A boxed promise: a lifecycle step returns it without the chain waiting
// for it (a hung bootstrap must not block a later switch or quitting).
type Box<T> = { done: Promise<T> }

// Test seam: tests shorten these.
export const managerTimings = {
  // A hung session stop must not block removing its account or quitting.
  stopBoundMs: 3000,
  // ponytail: FOREGROUND_HEAD_START, 1.5 s. The background accounts wait
  // this long for the foreground's start, then start anyway: a hung
  // foreground bootstrap must not keep them down.
  foregroundHeadStartMs: 1500,
  // ponytail: BACKGROUND_START_WAIT, 5 s. The background queue waits this
  // long for one account's start, then moves on: a hung bootstrap must not
  // keep the accounts behind it down. The slow start may still land later.
  backgroundStartWaitMs: 5000,
}

function persisted(s: AccountSlice): Persisted {
  return {
    messageCacheByConvo: s.messageCacheByConvo,
    chats: s.chats,
    teams: s.teams,
    nameByUserId: s.nameByUserId,
  }
}

// Resolve after `p` settles or `ms` passes, whichever is first; the timer
// does not outlive it.
async function bounded(p: Promise<unknown>, ms = managerTimings.stopBoundMs): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([p, new Promise((r) => (timer = setTimeout(r, ms)))])
  } finally {
    clearTimeout(timer)
  }
}

export function createAccountManager(
  store: Store<AppState>,
  profile: string | null,
  // Test seams: the session starter and the force-availability driver.
  startSessionImpl: typeof runSession = runSession,
  startForceDriverImpl: typeof startForceAvailabilityDriver = startForceAvailabilityDriver,
  // Decided by the caller with concurrentMode(); `profile` is then the
  // preferred foreground (activeAccount).
  concurrent = false,
): AccountManager {
  // Seeded/offline mode (tui-test, demos) must neither read nor write the real
  // per-profile caches: fixture data would overwrite ~/.cache/teaminal, and
  // real cached data would leak into deterministic snapshots.
  const seeded = isSeededMode()
  const persistCaches = !seeded
  const pollerHandleRef: PollerHandleRef = { current: null }
  const slots = new Map<AccountId, Slot>()
  let drainTimer: ReturnType<typeof setInterval> | null = null
  let stopped = false
  // Single mode: bumped by every start / switch / stopAll. A bootstrap that
  // resolves after a newer transition began is obsolete: it is stopped,
  // never installed.
  let transition = 0
  // Lifecycle steps (start / switch / reconcile / retry / stopAll) run one
  // at a time on this chain. Bootstraps are not on it; they come back boxed
  // and are superseded through `transition` / the slot attempt instead.
  let lifecycle: Promise<unknown> = Promise.resolve()
  function serialize<T>(step: () => T | Promise<T>): Promise<T> {
    const run = lifecycle.then(step)
    lifecycle = run.catch(() => {})
    return run
  }

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

  function addSlot(acc: AccountStore, p: string | null): Slot {
    let remove = () => {}
    const removed = new Promise<void>((r) => (remove = r))
    const slot: Slot = {
      ref: acc.ref,
      profile: p,
      acc,
      session: null,
      driver: null,
      attempt: 0,
      starting: null,
      failure: null,
      hydrated: false,
      removed,
      remove,
      paths: {
        message: getMessageCachePath(process.env, p),
        list: getListCachePath(process.env, p),
        name: getNameCachePath(process.env, p),
      },
      last: persisted(acc.get()),
    }
    slots.set(slot.ref.id, slot)
    return slot
  }

  const foregroundSlot = (): Slot | undefined => {
    const id = store.get().account?.id
    return id ? slots.get(id) : undefined
  }
  const slotForProfile = (p: string): Slot | undefined => slots.get(accountRef(p).id)
  const order = (slot: Slot): number => {
    const i = slot.profile === null ? -1 : store.get().settings.accounts.indexOf(slot.profile)
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }
  const isUp = (slot: Slot): boolean => (seeded ? slot.attempt > 0 : slot.session !== null)
  const runningSlots = (): Slot[] =>
    [...slots.values()].filter(isUp).sort((a, b) => order(a) - order(b))
  const syncPollerRef = (): void => {
    pollerHandleRef.current = foregroundSlot()?.session?.poller ?? null
  }
  const fallbackClient = (p: string | null): GraphClient =>
    createGraphClient({
      account: accountRef(p),
      ...audienceFromRouting(routingForAccount(store.get().settings, p)),
    })

  // Open the slots before mount; hydrate only the foreground's caches (cold
  // start: the others hydrate right before their own start).
  let activeProfile = profile
  if (concurrent) {
    const configured = store.get().settings.accounts
    activeProfile = profile !== null && configured.includes(profile) ? profile : configured[0]!
    for (const p of [activeProfile, ...configured.filter((c) => c !== activeProfile)]) {
      addSlot(openAccount(store, accountRef(p), { foreground: p === activeProfile }), p)
    }
  } else {
    addSlot(openAccount(store, accountRef(activeProfile), { foreground: true }), activeProfile)
  }
  {
    const fg = foregroundSlot()!
    if (persistCaches) hydrate(fg.acc, fg.profile)
    fg.hydrated = true
    fg.last = persisted(fg.acc.get())
  }

  // Persist caches on store changes (debounced inside each scheduler), one
  // comparison per slot against its own paths. A foreground swap moves
  // slices without changing a reference, so it schedules nothing. Empty
  // values are the wiped post-switch / hard-refresh state; writing them
  // would clobber the profile's cache before the poller refills it.
  const unsubscribe = store.subscribe((s) => {
    if (!persistCaches) return
    for (const slot of slots.values()) {
      const cur = accountSlice(s, slot.ref.id)
      if (!cur) continue
      const prev = slot.last
      slot.last = persisted(cur)
      if (
        cur.messageCacheByConvo !== prev.messageCacheByConvo &&
        Object.keys(cur.messageCacheByConvo).length > 0
      ) {
        scheduleMessageCacheSave(cur.messageCacheByConvo, undefined, slot.paths.message)
      }
      if (
        (cur.chats !== prev.chats || cur.teams !== prev.teams) &&
        (cur.chats.length > 0 || cur.teams.length > 0)
      ) {
        scheduleListCacheSave(
          { chats: cur.chats, teams: cur.teams, channelsByTeam: cur.channelsByTeam },
          undefined,
          slot.paths.list,
        )
      }
      if (cur.nameByUserId !== prev.nameByUserId && Object.keys(cur.nameByUserId).length > 0) {
        scheduleNameCacheSave(cur.nameByUserId, undefined, slot.paths.name)
      }
    }
  })

  function flushCaches(): void {
    for (const flush of [flushMessageCache, flushListCache, flushNameCache]) {
      try {
        flush()
      } catch {}
    }
  }

  // Stop a slot's driver and session. The slot itself stays. Concurrent
  // mode bounds the session stop: one hung account must not block removing
  // it or quitting.
  async function stopSlot(slot: Slot): Promise<void> {
    slot.driver?.stop()
    slot.driver = null
    const session = slot.session
    slot.session = null
    syncPollerRef()
    if (!session) return
    try {
      await (concurrent ? bounded(session.stop()) : session.stop())
    } catch (err) {
      warn('session: stop failed:', err instanceof Error ? err.message : String(err))
    }
  }

  // Start the slot's force driver and session. Called inside a lifecycle
  // step; the bootstrap comes back boxed so the chain does not wait for it.
  // It resolves once the session is installed, or stopped because it is no
  // longer wanted (or its slot closed) by the time it bootstrapped.
  function startSession(
    slot: Slot,
    wanted: () => boolean,
    onFatal: RunSessionOpts['onFatal'],
    onAuthExpired?: RunSessionOpts['onAuthExpired'],
  ): Box<void> {
    const driver = startForceDriverImpl(slot.acc)
    slot.driver = driver
    const done = (async () => {
      let session: SessionHandle
      try {
        session = await startSessionImpl({
          account: slot.acc,
          profile: slot.profile,
          onFatal,
          ...(concurrent
            ? {
                onAuthExpired,
                labelled: () => runningSlots().length > 1,
                listFilter: () => store.get().filter,
              }
            : {}),
        })
      } catch (err) {
        driver.stop()
        if (slot.driver === driver) slot.driver = null
        throw err
      }
      if (stopped || !wanted() || !slot.acc.isCurrent()) {
        debug('session: discarding a bootstrap superseded by a newer account transition')
        driver.stop()
        if (slot.driver === driver) slot.driver = null
        const stopping = session.stop().catch(() => {})
        await (concurrent ? bounded(stopping) : stopping)
        return
      }
      slot.session = session
      syncPollerRef()
      drainTimer ??= setInterval(() => drainNotifications(), 1000)
    })()
    return { done }
  }

  // ---- concurrent mode --------------------------------------------------

  function showAuthExpired(slot: Slot, message: string): void {
    store.set({
      modal: { kind: 'auth-expired', profile: slot.profile, message, status: 'idle' },
      inputZone: 'menu',
    })
  }

  // A failure stays in its slot (product contract 6): refresh-token expiry
  // (at start or mid-session) or an unauthorized /me -> authError (the
  // foreground also gets the auth-expired modal), any other start error ->
  // offline. The session stops, the slot stays. Nothing exits.
  async function failSlot(
    slot: Slot,
    wanted: () => boolean,
    err: Error,
    auth: boolean,
  ): Promise<Error | null> {
    if (stopped || !wanted()) return null
    warn(`session ${slot.ref.label}: ${slot.session ? 'stopped' : 'start failed'}:`, err.message)
    // Stop first, then set conn: a loop's own error handling writes conn
    // right after reporting the error.
    await stopSlot(slot)
    // stopAll may have run while the stop was pending.
    if (stopped || !wanted()) return null
    slot.failure = err.message
    slot.acc.set({ conn: auth ? 'authError' : 'offline' })
    if (auth && slot.acc.isForeground()) showAuthExpired(slot, err.message)
    return err
  }

  // Hydrate (first time only) and start a slot. Seeded mode loads fixtures
  // instead of starting a session.
  function beginStart(slot: Slot): Box<Error | null> {
    const attempt = ++slot.attempt
    if (seeded) {
      applySeededState(slot.acc, slot.profile)
      return { done: Promise.resolve(null) }
    }
    const wanted = () => slots.get(slot.ref.id) === slot && slot.attempt === attempt
    if (persistCaches && !slot.hydrated) hydrate(slot.acc, slot.profile)
    slot.hydrated = true
    slot.acc.set({ conn: 'connecting' })
    slot.failure = null
    // Set once: by onFatal during bootstrap, or by the first refresh-token
    // expiry a loop reports. Before the session is installed the settle
    // below fails the slot; after that the expiry does it directly.
    let fatal: string | null = null
    let installed = false
    const { done } = startSession(
      slot,
      wanted,
      (_kind, msg) => {
        fatal ??= msg
      },
      (err) => {
        if (fatal !== null) return
        fatal = err.message
        if (installed) void failSlot(slot, wanted, err, true)
      },
    )
    const settled = done.then(
      () => {
        installed = true
        return fatal === null ? null : failSlot(slot, wanted, new Error(fatal), true)
      },
      (err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err))
        return failSlot(slot, wanted, e, isRefreshExpiredError(e.message))
      },
    )
    slot.starting = settled
    void settled.then(() => {
      if (slot.starting === settled) slot.starting = null
    })
    return { done: settled }
  }

  // Background starts, one at a time in the order queued. Each re-checks
  // that its account is still wanted and not started meanwhile.
  // ponytail: sequential background starts; a pool of 2 if five accounts
  // feels slow.
  const queue: Slot[] = []
  let draining = false
  async function drain(): Promise<void> {
    if (draining) return
    draining = true
    try {
      while (queue.length > 0 && !stopped) {
        const slot = queue.shift()!
        const box = await serialize(() =>
          slots.get(slot.ref.id) === slot && slot.attempt === 0 ? beginStart(slot) : null,
        )
        // A slot removed while its start hangs releases the queue; so does
        // a start that takes too long.
        if (box)
          await bounded(
            Promise.race([box.done, slot.removed]),
            managerTimings.backgroundStartWaitMs,
          )
      }
    } finally {
      draining = false
    }
  }
  function enqueue(slot: Slot): void {
    queue.push(slot)
    void drain()
  }

  // An account that failed for auth and is not starting again shows its
  // auth-expired modal when it comes to the front.
  function toForeground(slot: Slot, opts?: { restoreUi?: boolean }): void {
    setForeground(store, slot.ref.id, opts)
    // Unified sidebar: an account swapped in with no remembered list cursor
    // starts on its own header, not at the top of the first account.
    const s = store.get()
    if (opts?.restoreUi !== false && s.cursorKey === null && unifiedSidebar(s)) {
      store.set({ cursorKey: accountRowKey(slot.ref.id) })
    }
    activeProfile = slot.profile
    syncPollerRef()
    if (
      concurrent &&
      !isUp(slot) &&
      !slot.starting &&
      slot.failure !== null &&
      slot.acc.get().conn === 'authError'
    ) {
      showAuthExpired(slot, slot.failure)
    }
  }

  async function removeSlot(slot: Slot): Promise<void> {
    // Out of the map first: its bootstrap is no longer wanted and the
    // persistence subscriber stops looking at it.
    slots.delete(slot.ref.id)
    slot.remove()
    await stopSlot(slot)
    flushCaches()
    if (slot.acc.isForeground()) {
      const { accounts, activeAccount } = store.get().settings
      const order = activeAccount ? [activeAccount, ...accounts] : accounts
      // Remaining slots that are being removed too (reconcile) count as a
      // last resort: one of them must hold the foreground until it closes.
      const next = order.map(slotForProfile).find((s) => s !== undefined) ?? [...slots.values()][0]
      if (next) toForeground(next)
    }
    closeAccount(store, slot.ref.id)
    if (store.get().account === null) {
      // Nothing left: no session, and the Accounts modal stays open so an
      // account can be added again.
      activeProfile = null
      store.set({
        modal: { kind: 'accounts', mode: 'list', cursor: 0, accounts: [] },
        inputZone: 'menu',
      })
    }
    syncPollerRef()
  }

  // ------------------------------------------------------------------------

  return {
    pollerHandleRef,
    activeProfile: () => activeProfile,
    client: () => foregroundSlot()?.session?.client() ?? fallbackClient(activeProfile),
    clientFor: (id) => {
      const slot = slots.get(id)
      if (!slot) throw new Error(`clientFor: account ${id} is not open`)
      return slot.session?.client() ?? fallbackClient(slot.profile)
    },
    retryRealtime: () => foregroundSlot()?.session?.transport?.retry(),
    running: () => runningSlots().map((s) => s.ref),

    async start(onFatal) {
      if (concurrent) {
        const fg = foregroundSlot()
        if (stopped || !fg) return
        const box = await serialize(() =>
          slots.get(fg.ref.id) === fg && fg.attempt === 0 ? beginStart(fg) : null,
        )
        if (box) await bounded(box.done, managerTimings.foregroundHeadStartMs)
        for (const p of store.get().settings.accounts) {
          const slot = slotForProfile(p)
          if (slot && slot !== fg) enqueue(slot)
        }
        return
      }
      if (seeded) {
        // Deterministic fixture data, no Graph / owa-piggy auth.
        debug('bootstrap: seeded mode active (TEAMINAL_SEED=%s)', process.env.TEAMINAL_SEED)
        applySeededState(foregroundSlot()!.acc, activeProfile)
        return
      }
      // Always kicks off the bootstrap, even when a switch or stopAll is
      // already queued behind it: that one supersedes and stops it.
      const mine = ++transition
      const started = await serialize(() =>
        startSession(foregroundSlot()!, () => mine === transition, onFatal),
      )
      await started.done
    },

    async switchAccount(nextProfile) {
      if (stopped) return
      if (concurrent) {
        const box = await serialize(() => {
          const slot = nextProfile === null ? undefined : slotForProfile(nextProfile)
          if (!slot) throw new Error(`${nextProfile ?? '(default)'} is not a configured account`)
          const pending = isUp(slot)
            ? null
            : slot.starting
              ? { done: slot.starting }
              : beginStart(slot)
          toForeground(slot)
          return pending
        })
        const err = await box?.done
        if (err) throw err
        return
      }
      const mine = ++transition
      const started = await serialize(async () => {
        // A newer switch (or stopAll) was requested while this one waited.
        // Checked here, not before queueing, so the last request wins.
        const current = foregroundSlot()
        if (mine !== transition || current?.session?.profile === nextProfile) return null
        // Tear down the running session first so its loops can't write into
        // the about-to-be-reset store.
        if (current) await stopSlot(current)
        if (mine !== transition) return null
        // Flush the previous profile's caches; its slot goes with the reset.
        flushCaches()
        slots.clear()
        activeProfile = nextProfile
        // The reset re-opens the slot with a new generation, so every handle
        // held by async work drops its writes instead of landing in another
        // account (even across A -> B -> A). Done at the reset itself, not at
        // the start of the switch: work begun during teardown still holds the
        // old session's client and must count as stale too.
        resetAccountScopedState(store, accountRef(activeProfile))
        const slot = addSlot(accountStore(store), activeProfile)
        // Seeded mode switches between fixture accounts without a session.
        if (seeded) {
          applySeededState(slot.acc, activeProfile)
          return null
        }
        if (persistCaches) hydrate(slot.acc, activeProfile)
        slot.hydrated = true
        return startSession(
          slot,
          () => mine === transition,
          (kind, msg) => {
            warn(`bootstrap: fatal (${kind}): ${msg}`)
          },
        )
      })
      try {
        await started?.done
      } catch (err) {
        warn('switch: bootstrap failed:', err instanceof Error ? err.message : String(err))
        throw err
      }
    },

    setForeground(p, opts) {
      const slot = slotForProfile(p)
      if (!slot) throw new Error(`setForeground: ${p} is not open`)
      toForeground(slot, opts)
    },

    async retry(p) {
      if (stopped || !concurrent) return
      const box = await serialize(async () => {
        const slot = slotForProfile(p)
        if (!slot) return null
        if (isUp(slot)) {
          // A running session whose loops report a failure (a Graph 401,
          // offline) is stopped and started again.
          const { conn } = slot.acc.get()
          if (conn !== 'authError' && conn !== 'offline') return null
          await stopSlot(slot)
          if (stopped) return null
        }
        return slot.starting ? { done: slot.starting } : beginStart(slot)
      })
      const err = await box?.done
      if (err) throw err
    },

    async reconcile() {
      if (stopped || !concurrent) return
      await serialize(async () => {
        const configured = store.get().settings.accounts
        for (const slot of [...slots.values()]) {
          if (slot.profile === null || !configured.includes(slot.profile)) await removeSlot(slot)
        }
        for (const p of configured) {
          if (slotForProfile(p)) continue
          const foreground = store.get().account === null
          const slot = addSlot(openAccount(store, accountRef(p), { foreground }), p)
          if (foreground) activeProfile = p
          enqueue(slot)
        }
      })
    },

    async stopAll() {
      if (stopped) return
      stopped = true
      transition++
      await serialize(async () => {
        unsubscribe()
        // Keep the drivers past the session stops: their reset() puts a
        // picked presence back to Available (bounded at 3 s each) once
        // caches are safe.
        const all = [...slots.values()]
        const drivers = all.flatMap((s) => (s.driver ? [s.driver] : []))
        for (const s of all) s.driver = null
        await Promise.all(all.map(stopSlot))
        flushCaches()
        if (drainTimer) clearInterval(drainTimer)
        drainTimer = null
        await Promise.all(drivers.map((d) => d.reset()))
        for (const d of drivers) d.stop()
      })
    },
  }
}
