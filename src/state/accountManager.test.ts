import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountRef } from '../account'
import { subscribeEvents } from '../log'
import { createAccountManager, managerTimings } from './accountManager'
import { accountStoreFor, type AccountStore } from './accountStore'
import type { RunSessionOpts, SessionHandle } from './bootstrap'
import type { ForceAvailabilityHandle } from './forceAvailability'
import type { PollerHandle } from './poller'
import {
  flushMessageCache,
  getMessageCachePath,
  loadMessageCache,
  saveMessageCacheNow,
} from './messageCachePersistence'
import { createAppStore, emptyMessageCache, resetAccountScopedState } from './store'

const realSeed = process.env.TEAMINAL_SEED
const realXdg = process.env.XDG_CACHE_HOME
let cacheRoot = ''
const realTimings = { ...managerTimings }

const noDriver = (): ForceAvailabilityHandle => ({ stop() {}, async reset() {} })
const tick = () => new Promise((r) => setTimeout(r, 0))

// A fake session that records its lifecycle; its poller and transport are
// distinct objects so the tests can tell which session the manager exposes.
type FakeSession = SessionHandle & { stopped: boolean; retries: number; opts: RunSessionOpts }
function fakeSession(opts: RunSessionOpts): FakeSession {
  const session: FakeSession = {
    profile: opts.profile,
    opts,
    stopped: false,
    retries: 0,
    client: () => ({ profile: opts.profile }) as never,
    poller: { name: opts.profile } as unknown as PollerHandle,
    transport: {
      retry: () => {
        session.retries++
      },
    } as never,
    stop: async () => {
      session.stopped = true
    },
  }
  return session
}

// Records every driver the manager starts: its account and its calls.
type DriverLog = { account: string; ops: string[] }
function driverRecorder() {
  const drivers: DriverLog[] = []
  const start = (acc: AccountStore): ForceAvailabilityHandle => {
    const log: DriverLog = { account: acc.ref.label, ops: [] }
    drivers.push(log)
    return {
      stop: () => {
        log.ops.push('stop')
      },
      reset: async () => {
        log.ops.push('reset')
      },
    }
  }
  return { drivers, start }
}

function nonSeeded(): void {
  delete process.env.TEAMINAL_SEED
  cacheRoot = mkdtempSync(join(tmpdir(), 'teaminal-manager-'))
  process.env.XDG_CACHE_HOME = cacheRoot
}

afterEach(() => {
  Object.assign(managerTimings, realTimings)
  if (realSeed === undefined) delete process.env.TEAMINAL_SEED
  else process.env.TEAMINAL_SEED = realSeed
  if (realXdg === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = realXdg
  if (cacheRoot) rmSync(cacheRoot, { recursive: true, force: true })
  cacheRoot = ''
})

describe('AccountManager', () => {
  test('seeded mode: start and switch load each account; stopAll is idempotent', async () => {
    process.env.TEAMINAL_SEED = 'fixtures'
    const store = createAppStore()
    const m = createAccountManager(store, 'alpha')
    expect(store.get().account?.id).toBe(accountRef('alpha').id)
    await m.start(() => {})
    const alphaTopic = store.get().chats.find((c) => c.topic)?.topic
    expect(alphaTopic).toBeTruthy()

    const generation = store.get().accountGeneration
    await m.switchAccount('beta')
    expect(m.activeProfile()).toBe('beta')
    expect(store.get().account?.id).toBe(accountRef('beta').id)
    expect(store.get().accountGeneration).toBe(generation + 1)
    expect(store.get().chats.find((c) => c.topic)?.topic).toBe(alphaTopic!.toUpperCase())

    await m.stopAll()
    await m.stopAll()
  })

  test("caches persist to the active profile's path", async () => {
    delete process.env.TEAMINAL_SEED
    cacheRoot = mkdtempSync(join(tmpdir(), 'teaminal-manager-'))
    process.env.XDG_CACHE_HOME = cacheRoot
    const store = createAppStore()
    const m = createAccountManager(store, 'alpha')
    const cache = emptyMessageCache([
      {
        id: 'm1',
        createdDateTime: '2026-01-01T00:00:00Z',
        body: { contentType: 'text', content: 'hi' },
      },
    ])
    store.set({ messageCacheByConvo: { 'chat:c1': cache } })
    await m.stopAll() // flushes the debounced write

    const path = getMessageCachePath(process.env, 'alpha')
    expect(existsSync(path)).toBe(true)
    expect(Object.keys(loadMessageCache(path))).toEqual(['chat:c1'])
    expect(existsSync(getMessageCachePath(process.env, null))).toBe(false)
  })

  test('a bootstrap that resolves after a newer transition is stopped, not installed', async () => {
    delete process.env.TEAMINAL_SEED
    cacheRoot = mkdtempSync(join(tmpdir(), 'teaminal-manager-'))
    process.env.XDG_CACHE_HOME = cacheRoot
    const stopped: string[] = []
    const release: Record<string, (s: SessionHandle) => void> = {}
    const fake = (profile: string | null) =>
      ({
        profile,
        stop: async () => {
          stopped.push(String(profile))
        },
        client: () => ({ profile }),
      }) as unknown as SessionHandle
    const store = createAppStore()
    const m = createAccountManager(
      store,
      'alpha',
      (opts) => {
        return new Promise((resolve) => (release[String(opts.profile)] = resolve))
      },
      noDriver,
    )
    const starting = m.start(() => {})
    const toBeta = m.switchAccount('beta')
    await tick() // beta reaches its bootstrap
    const toGamma = m.switchAccount('gamma')
    await tick()
    release.gamma!(fake('gamma'))
    await toGamma
    release.alpha!(fake('alpha'))
    release.beta!(fake('beta'))
    await Promise.all([starting, toBeta])
    expect(stopped.sort()).toEqual(['alpha', 'beta'])
    expect((m.client() as unknown as { profile: string }).profile).toBe('gamma')

    // Shutdown while a bootstrap is pending: the late session is stopped too.
    const m2 = createAccountManager(
      createAppStore(),
      'delta',
      (opts) => {
        return new Promise((resolve) => (release[String(opts.profile)] = resolve))
      },
      noDriver,
    )
    const late = m2.start(() => {})
    await m2.stopAll()
    release.delta!(fake('delta'))
    await late
    expect(stopped).toContain('delta')
    await m.stopAll()
  })

  test('the poller ref and realtime retry follow the installed session', async () => {
    nonSeeded()
    const sessions: FakeSession[] = []
    const release: Record<string, () => void> = {}
    const store = createAppStore()
    const m = createAccountManager(
      store,
      'alpha',
      (opts) => {
        const s = fakeSession(opts)
        sessions.push(s)
        return new Promise((resolve) => (release[String(opts.profile)] = () => resolve(s)))
      },
      noDriver,
    )
    const starting = m.start(() => {})
    await tick()
    expect(m.pollerHandleRef.current).toBeNull()
    release.alpha!()
    await starting
    const [alpha] = sessions
    expect(m.pollerHandleRef.current).toBe(alpha!.poller)
    // The session got the foreground slot's handle.
    expect(alpha!.opts.account.ref.id).toBe(accountRef('alpha').id)
    expect(alpha!.opts.account.isForeground()).toBe(true)
    m.retryRealtime()
    expect(alpha!.retries).toBe(1)

    // While the next session bootstraps, the UI sees no poller at all.
    const switching = m.switchAccount('beta')
    await tick()
    expect(alpha!.stopped).toBe(true)
    expect(alpha!.opts.account.isCurrent()).toBe(false)
    expect(m.pollerHandleRef.current).toBeNull()
    m.retryRealtime()
    expect(alpha!.retries).toBe(1)
    release.beta!()
    await switching
    const beta = sessions[1]!
    expect(m.pollerHandleRef.current).toBe(beta.poller)
    m.retryRealtime()
    expect(beta.retries).toBe(1)

    await m.stopAll()
    expect(beta.stopped).toBe(true)
    expect(m.pollerHandleRef.current).toBeNull()
  })

  test('a force driver runs with each session; only stopAll resets it', async () => {
    nonSeeded()
    const { drivers, start } = driverRecorder()
    const store = createAppStore()
    const m = createAccountManager(store, 'alpha', async (opts) => fakeSession(opts), start)
    await m.start(() => {})
    expect(drivers).toEqual([{ account: 'alpha', ops: [] }])
    await m.switchAccount('beta')
    expect(drivers).toEqual([
      { account: 'alpha', ops: ['stop'] },
      { account: 'beta', ops: [] },
    ])
    await m.stopAll()
    expect(drivers[1]).toEqual({ account: 'beta', ops: ['reset', 'stop'] })
    expect(drivers[0]!.ops).toEqual(['stop'])
  })

  test('a failed bootstrap stops its driver', async () => {
    nonSeeded()
    const { drivers, start } = driverRecorder()
    const m = createAccountManager(
      createAppStore(),
      'alpha',
      async () => {
        throw new Error('refresh token expired')
      },
      start,
    )
    await expect(m.start(() => {})).rejects.toThrow('refresh token expired')
    expect(drivers).toEqual([{ account: 'alpha', ops: ['stop'] }])
    await m.stopAll()
    expect(drivers[0]!.ops).toEqual(['stop'])
  })

  test('overlapping switches end with exactly one running session and driver', async () => {
    nonSeeded()
    const { drivers, start } = driverRecorder()
    const sessions: FakeSession[] = []
    const release: (() => void)[] = []
    const store = createAppStore()
    const m = createAccountManager(
      store,
      'alpha',
      (opts) => {
        const s = fakeSession(opts)
        sessions.push(s)
        return new Promise((resolve) => release.push(() => resolve(s)))
      },
      start,
    )
    // Each transition reaches its bootstrap before the next one starts, so
    // four bootstraps are pending at once.
    const starting = m.start(() => {})
    await tick()
    const toBeta = m.switchAccount('beta')
    await tick()
    const toGamma = m.switchAccount('gamma')
    await tick()
    const toBetaAgain = m.switchAccount('beta')
    await tick()
    expect(sessions.map((s) => s.profile)).toEqual(['alpha', 'beta', 'gamma', 'beta'])
    // Release in reverse order: the newest bootstrap lands first.
    for (const r of release.reverse()) r()
    await Promise.all([starting, toBeta, toGamma, toBetaAgain])
    const running = sessions.filter((s) => !s.stopped)
    expect(running.map((s) => s.profile)).toEqual(['beta'])
    expect(m.pollerHandleRef.current).toBe(running[0]!.poller)
    expect(drivers.filter((d) => !d.ops.includes('stop')).map((d) => d.account)).toEqual(['beta'])
    expect(store.get().account?.id).toBe(accountRef('beta').id)
    await m.stopAll()
    expect(sessions.every((s) => s.stopped)).toBe(true)
  })

  test('switching away and straight back keeps the running session (last request wins)', async () => {
    nonSeeded()
    const sessions: FakeSession[] = []
    const store = createAppStore()
    const m = createAccountManager(
      store,
      'alpha',
      async (opts) => {
        const s = fakeSession(opts)
        sessions.push(s)
        return s
      },
      noDriver,
    )
    await m.start(() => {})
    await Promise.all([m.switchAccount('beta'), m.switchAccount('alpha')])
    expect(sessions.map((s) => [s.profile, s.stopped])).toEqual([['alpha', false]])
    expect(m.activeProfile()).toBe('alpha')
    await m.stopAll()
  })

  test('a bootstrap whose slot was re-opened meanwhile is discarded', async () => {
    nonSeeded()
    let release = () => {}
    let session: FakeSession | undefined
    const store = createAppStore()
    const m = createAccountManager(
      store,
      'alpha',
      (opts) => {
        session = fakeSession(opts)
        return new Promise((resolve) => (release = () => resolve(session!)))
      },
      noDriver,
    )
    const starting = m.start(() => {})
    await tick()
    resetAccountScopedState(store, accountRef('alpha'))
    release()
    await starting
    expect(session!.stopped).toBe(true)
    expect(m.pollerHandleRef.current).toBeNull()
    await m.stopAll()
  })
})

// ---- concurrent mode (M2 E.4) ---------------------------------------------

const msg = (id: string, content: string) => ({
  id,
  createdDateTime: '2026-01-01T00:00:00Z',
  body: { contentType: 'text' as const, content },
})

function concurrentStore(accounts: string[], activeAccount: string | null = accounts[0]!) {
  const store = createAppStore()
  store.set((s) => ({
    settings: { ...s.settings, accounts, activeAccount, concurrentAccounts: true },
  }))
  return store
}

// Fake sessions whose bootstraps the test releases (or fails) per profile.
function heldSessions() {
  const sessions: FakeSession[] = []
  const requested: string[] = []
  const pending: Record<string, { release: () => void; fail: (err: Error) => void }> = {}
  const start = (opts: RunSessionOpts): Promise<SessionHandle> => {
    const p = String(opts.profile)
    requested.push(p)
    return new Promise((resolve, reject) => {
      pending[p] = {
        release: () => {
          const s = fakeSession(opts)
          sessions.push(s)
          resolve(s)
        },
        fail: reject,
      }
    })
  }
  return { sessions, requested, pending, start }
}

const instant = async (opts: RunSessionOpts) => fakeSession(opts)

describe('concurrentMode', () => {
  test('flag on, no --profile, at least one account', async () => {
    const { concurrentMode } = await import('./accountManager')
    const s = createAppStore().get().settings
    const on = { ...s, concurrentAccounts: true, accounts: ['alpha'] }
    expect(concurrentMode(on, undefined)).toBe(true)
    expect(concurrentMode(on, 'alpha')).toBe(false)
    expect(concurrentMode({ ...on, accounts: [] }, undefined)).toBe(false)
    expect(concurrentMode({ ...on, concurrentAccounts: false }, undefined)).toBe(false)
  })
})

describe('AccountManager (concurrent)', () => {
  test('opens every slot; hydrates and starts the foreground first, then the others one at a time', async () => {
    nonSeeded()
    for (const [p, text] of [
      ['alpha', 'alpha text'],
      ['beta', 'beta text'],
    ] as const) {
      saveMessageCacheNow(
        { 'chat:c1': emptyMessageCache([msg('m1', text)]) },
        getMessageCachePath(process.env, p),
      )
    }
    const held = heldSessions()
    const store = concurrentStore(['alpha', 'beta', 'gamma'], 'beta')
    const m = createAccountManager(store, 'beta', held.start, noDriver, true)
    const s = store.get()
    // activeAccount is in front; the others are open in the background.
    expect(s.account?.id).toBe(accountRef('beta').id)
    expect(Object.keys(s.backgroundAccounts).sort()).toEqual(
      [accountRef('alpha').id, accountRef('gamma').id].sort(),
    )
    // Only the foreground's caches before mount.
    expect(s.messagesByConvo['chat:c1']?.[0]?.body.content).toBe('beta text')
    expect(s.backgroundAccounts[accountRef('alpha').id]?.messagesByConvo).toEqual({})

    const starting = m.start(() => {})
    await tick()
    expect(held.requested).toEqual(['beta'])
    held.pending.beta!.release()
    await starting
    await tick()
    // alpha next, hydrated right before its start; gamma waits for it.
    expect(held.requested).toEqual(['beta', 'alpha'])
    const alphaSlice = store.get().backgroundAccounts[accountRef('alpha').id]
    expect(alphaSlice?.messagesByConvo['chat:c1']?.[0]?.body.content).toBe('alpha text')
    held.pending.alpha!.release()
    await tick()
    await tick()
    expect(held.requested).toEqual(['beta', 'alpha', 'gamma'])
    held.pending.gamma!.release()
    await tick()
    expect(m.running().map((r) => r.label)).toEqual(['alpha', 'beta', 'gamma'])
    expect(m.pollerHandleRef.current).toBe(held.sessions[0]!.poller)
    await m.stopAll()
  })

  test('initial foreground falls back to the first account', () => {
    nonSeeded()
    const store = concurrentStore(['alpha', 'beta'], 'nope')
    const m = createAccountManager(store, 'nope', instant, noDriver, true)
    expect(store.get().account?.id).toBe(accountRef('alpha').id)
    expect(m.activeProfile()).toBe('alpha')
  })

  test('switchAccount swaps instantly: nothing stops, poller ref follows, focus comes back', async () => {
    nonSeeded()
    const sessions: FakeSession[] = []
    const store = concurrentStore(['alpha', 'beta'])
    const m = createAccountManager(
      store,
      'alpha',
      async (opts) => {
        const s = fakeSession(opts)
        sessions.push(s)
        return s
      },
      noDriver,
      true,
    )
    await m.start(() => {})
    await waitFor(() => m.running().length === 2)
    const [alpha, beta] = sessions
    const generations = store.get().generationById
    store.set({ focus: { kind: 'chat', chatId: 'c1' } })

    await m.switchAccount('beta')
    expect(store.get().account?.id).toBe(accountRef('beta').id)
    expect(store.get().focus).toEqual({ kind: 'list' })
    expect(m.activeProfile()).toBe('beta')
    expect(m.pollerHandleRef.current).toBe(beta!.poller)
    m.retryRealtime()
    expect(beta!.retries).toBe(1)
    expect((m.client() as unknown as { profile: string }).profile).toBe('beta')
    expect((m.clientFor(accountRef('alpha').id) as unknown as { profile: string }).profile).toBe(
      'alpha',
    )

    await m.switchAccount('alpha')
    expect(store.get().focus).toEqual({ kind: 'chat', chatId: 'c1' })
    expect(m.pollerHandleRef.current).toBe(alpha!.poller)
    expect(sessions.every((s) => !s.stopped)).toBe(true)
    expect(store.get().generationById).toEqual(generations)
    await expect(m.switchAccount('nope')).rejects.toThrow('not a configured account')
    await m.stopAll()
  })

  test('setForeground: a fresh account starts on its header; restoreUi false keeps the cursor', async () => {
    nonSeeded()
    const sessions: FakeSession[] = []
    const store = concurrentStore(['alpha', 'beta'])
    const m = createAccountManager(
      store,
      'alpha',
      async (opts) => {
        const s = fakeSession(opts)
        sessions.push(s)
        return s
      },
      noDriver,
      true,
    )
    await m.start(() => {})
    await waitFor(() => m.running().length === 2)
    // Unified sidebar: beta has no remembered cursor, so it lands on its header.
    m.setForeground('beta')
    expect(store.get().cursorKey).toBe(`account:${accountRef('beta').id}`)
    // Opening a row of alpha's section: the list cursor and filter stay.
    store.set({ cursor: 2, cursorKey: 'row', filter: 'x' })
    m.setForeground('alpha', { restoreUi: false })
    expect(store.get()).toMatchObject({ cursor: 2, cursorKey: 'row', filter: 'x' })
    expect(store.get().account?.id).toBe(accountRef('alpha').id)
    expect(m.pollerHandleRef.current).toBe(sessions[0]!.poller)
    await m.stopAll()
  })

  test('a failed start stays local to its account and never exits', async () => {
    nonSeeded()
    const held = heldSessions()
    const { drivers, start: startDriver } = driverRecorder()
    const store = concurrentStore(['alpha', 'beta', 'gamma'])
    let fatalCalls = 0
    const m = createAccountManager(store, 'alpha', held.start, startDriver, true)
    const starting = m.start(() => fatalCalls++)
    await tick()
    held.pending.alpha!.release()
    await starting
    await tick()
    // beta: refresh token expired -> authError, but it is in the background:
    // no modal.
    held.pending.beta!.fail(new Error('AADSTS700082: The refresh token has expired'))
    await waitFor(() => held.requested.includes('gamma'))
    const bg = (p: string) => store.get().backgroundAccounts[accountRef(p).id]
    expect(bg('beta')?.conn).toBe('authError')
    expect(store.get().modal).toBeNull()
    // gamma: anything else -> offline.
    held.pending.gamma!.fail(new Error('socket hang up'))
    await waitFor(() => bg('gamma')?.conn === 'offline')
    expect(m.running().map((r) => r.label)).toEqual(['alpha'])
    expect(store.get().conn).toBe('connecting') // alpha untouched
    expect(fatalCalls).toBe(0)
    // Failed starts leave no driver running.
    expect(drivers.filter((d) => !d.ops.includes('stop')).map((d) => d.account)).toEqual(['alpha'])

    // Switching to a failed account starts it again; a second failure
    // throws to the caller, opens the auth-expired modal now that it is in
    // front, and still leaves the app running.
    const switching = m.switchAccount('beta')
    await tick()
    expect(store.get().account?.id).toBe(accountRef('beta').id)
    expect(store.get().conn).toBe('connecting')
    held.pending.beta!.fail(new Error('AADSTS700082: expired again'))
    await expect(switching).rejects.toThrow('expired again')
    expect(store.get().conn).toBe('authError')
    expect(store.get().modal?.kind).toBe('auth-expired')

    // retry brings gamma up.
    const retrying = m.retry('gamma')
    await tick()
    held.pending.gamma!.release()
    await retrying
    expect(m.running().map((r) => r.label)).toEqual(['alpha', 'gamma'])
    await m.stopAll()
  })

  test("onFatal('unauthorized') marks the account authError instead of exiting", async () => {
    nonSeeded()
    const { drivers, start: startDriver } = driverRecorder()
    const store = concurrentStore(['alpha'])
    const m = createAccountManager(
      store,
      'alpha',
      async (opts) => {
        opts.onFatal('unauthorized', 'token rejected')
        return { ...fakeSession(opts), poller: null }
      },
      startDriver,
      true,
    )
    let fatalCalls = 0
    await m.start(() => fatalCalls++)
    expect(fatalCalls).toBe(0)
    expect(store.get().conn).toBe('authError')
    expect(store.get().modal?.kind).toBe('auth-expired')
    expect(m.running()).toEqual([])
    expect(drivers[0]!.ops).toEqual(['stop'])
    await m.stopAll()
  })

  test('reconcile: added accounts start in the background, removed ones stop and close', async () => {
    nonSeeded()
    const sessions: FakeSession[] = []
    const store = concurrentStore(['alpha', 'beta'])
    const m = createAccountManager(
      store,
      'alpha',
      async (opts) => {
        const s = fakeSession(opts)
        sessions.push(s)
        return s
      },
      noDriver,
      true,
    )
    await m.start(() => {})
    await waitFor(() => m.running().length === 2)
    const setAccounts = (accounts: string[], activeAccount = accounts[0] ?? null) =>
      store.set((s) => ({ settings: { ...s.settings, accounts, activeAccount } }))

    setAccounts(['alpha', 'beta', 'gamma'])
    await m.reconcile()
    await waitFor(() => m.running().length === 3)
    expect(store.get().account?.id).toBe(accountRef('alpha').id)

    // Removing the foreground moves to the next configured account first.
    store.set({ focus: { kind: 'chat', chatId: 'c1' } })
    setAccounts(['beta', 'gamma'])
    await m.reconcile()
    const alpha = sessions.find((s) => s.profile === 'alpha')!
    expect(alpha.stopped).toBe(true)
    expect(alpha.opts.account.isCurrent()).toBe(false)
    expect(store.get().account?.id).toBe(accountRef('beta').id)
    expect(store.get().generationById[accountRef('alpha').id]).toBeUndefined()
    expect(m.running().map((r) => r.label)).toEqual(['beta', 'gamma'])
    expect(m.pollerHandleRef.current).toBe(sessions.find((s) => s.profile === 'beta')!.poller)

    // Removing everything leaves no session and the Accounts modal open.
    setAccounts([])
    await m.reconcile()
    expect(store.get().account).toBeNull()
    expect(store.get().modal?.kind).toBe('accounts')
    expect(m.running()).toEqual([])
    expect(m.activeProfile()).toBeNull()
    expect(m.pollerHandleRef.current).toBeNull()
    expect(sessions.every((s) => s.stopped)).toBe(true)

    // Adding one back brings it up in front.
    setAccounts(['delta'])
    await m.reconcile()
    await waitFor(() => m.running().length === 1)
    expect(store.get().account?.id).toBe(accountRef('delta').id)
    expect(m.activeProfile()).toBe('delta')
    await m.stopAll()
  })

  test('an account removed while queued never starts; one removed mid-start is stopped', async () => {
    nonSeeded()
    const held = heldSessions()
    const store = concurrentStore(['alpha', 'beta', 'gamma'])
    const m = createAccountManager(store, 'alpha', held.start, noDriver, true)
    const starting = m.start(() => {})
    await tick()
    held.pending.alpha!.release()
    await starting
    await tick()
    expect(held.requested).toEqual(['alpha', 'beta'])
    // beta is bootstrapping, gamma is queued behind it.
    store.set((s) => ({ settings: { ...s.settings, accounts: ['alpha'] } }))
    await m.reconcile()
    held.pending.beta!.release()
    await tick()
    await tick()
    expect(held.requested).toEqual(['alpha', 'beta'])
    expect(held.sessions.find((s) => s.profile === 'beta')!.stopped).toBe(true)
    expect(m.running().map((r) => r.label)).toEqual(['alpha'])
    await m.stopAll()
  })

  test('a hung start whose account is removed releases the queue; its late stop is bounded', async () => {
    nonSeeded()
    managerTimings.stopBoundMs = 20
    const held = heldSessions()
    const store = concurrentStore(['alpha', 'beta', 'gamma'])
    const m = createAccountManager(store, 'alpha', held.start, noDriver, true)
    const starting = m.start(() => {})
    await tick()
    held.pending.alpha!.release()
    await starting
    await waitFor(() => held.requested.includes('beta'))
    // beta hangs in its bootstrap; switching to it waits on that start.
    const switching = m.switchAccount('beta')
    await tick()
    store.set((s) => ({ settings: { ...s.settings, accounts: ['alpha', 'gamma'] } }))
    await m.reconcile()
    // gamma starts although beta's bootstrap never settled.
    await waitFor(() => held.requested.includes('gamma'))
    held.pending.gamma!.release()
    await waitFor(
      () =>
        m
          .running()
          .map((r) => r.label)
          .join() === 'alpha,gamma',
    )
    // beta's bootstrap lands late with a stop that never returns: the
    // discarded session's teardown is bounded, so the switch settles.
    held.pending.beta!.release()
    const beta = held.sessions.find((s) => s.profile === 'beta')!
    beta.stop = () => new Promise(() => {})
    await switching
    expect(store.get().account?.id).toBe(accountRef('alpha').id)
    await m.stopAll()
  })

  test('a hung foreground start does not keep the background accounts down', async () => {
    nonSeeded()
    managerTimings.foregroundHeadStartMs = 10
    const held = heldSessions()
    const store = concurrentStore(['alpha', 'beta'])
    const m = createAccountManager(store, 'alpha', held.start, noDriver, true)
    // start() returns after the head start; alpha is still bootstrapping.
    await m.start(() => {})
    expect(held.requested).toEqual(['alpha', 'beta'])
    held.pending.beta!.release()
    await waitFor(
      () =>
        m
          .running()
          .map((r) => r.label)
          .join() === 'beta',
    )
    // alpha's start keeps running and lands later.
    held.pending.alpha!.release()
    await waitFor(() => m.running().length === 2)
    expect(m.pollerHandleRef.current).toBe(held.sessions.find((s) => s.profile === 'alpha')!.poller)
    await m.stopAll()
  })

  test('a hung background start does not keep the accounts queued behind it down', async () => {
    nonSeeded()
    managerTimings.backgroundStartWaitMs = 10
    const held = heldSessions()
    const store = concurrentStore(['alpha', 'beta', 'gamma'])
    const m = createAccountManager(store, 'alpha', held.start, noDriver, true)
    const starting = m.start(() => {})
    await tick()
    held.pending.alpha!.release()
    await starting
    // beta hangs and stays configured; gamma starts anyway.
    await waitFor(() => held.requested.includes('gamma'))
    held.pending.gamma!.release()
    await waitFor(() => m.running().length === 2)
    // beta's start lands late and is installed.
    held.pending.beta!.release()
    await waitFor(() => m.running().length === 3)
    await m.stopAll()
  })

  test('retry restarts a running account whose loops report authError or offline', async () => {
    nonSeeded()
    const sessions: FakeSession[] = []
    const store = concurrentStore(['alpha', 'beta'])
    const m = createAccountManager(
      store,
      'alpha',
      async (opts) => {
        const s = fakeSession(opts)
        sessions.push(s)
        return s
      },
      noDriver,
      true,
    )
    await m.start(() => {})
    await waitFor(() => m.running().length === 2)
    const session = (p: string) => sessions.filter((s) => s.profile === p).at(-1)!
    const betaBefore = session('beta')
    // A healthy running account: retry does nothing.
    await m.retry('beta')
    expect(session('beta')).toBe(betaBefore)
    // The list loop saw a Graph 401: the session is up but failed.
    betaBefore.opts.account.set({ conn: 'authError' })
    await m.retry('beta')
    expect(betaBefore.stopped).toBe(true)
    expect(session('beta')).not.toBe(betaBefore)
    expect(store.get().backgroundAccounts[accountRef('beta').id]?.conn).toBe('connecting')
    expect(m.running().map((r) => r.label)).toEqual(['alpha', 'beta'])
    // Same for offline on the foreground.
    const alphaBefore = session('alpha')
    alphaBefore.opts.account.set({ conn: 'offline' })
    await m.retry('alpha')
    expect(alphaBefore.stopped).toBe(true)
    expect(session('alpha')).not.toBe(alphaBefore)
    expect(m.pollerHandleRef.current).toBe(session('alpha').poller)
    // A quit while the failed session is stopping starts nothing.
    const alphaNow = session('alpha')
    let release = () => {}
    alphaNow.stop = () => new Promise<void>((r) => (release = r))
    alphaNow.opts.account.set({ conn: 'offline' })
    const retrying = m.retry('alpha')
    await tick()
    const stopping = m.stopAll()
    release()
    await Promise.all([retrying, stopping])
    expect(session('alpha')).toBe(alphaNow)
  })

  test('an expiry whose teardown outlasts stopAll writes nothing afterwards', async () => {
    nonSeeded()
    const sessions: FakeSession[] = []
    const store = concurrentStore(['alpha', 'beta'])
    const m = createAccountManager(
      store,
      'alpha',
      async (opts) => {
        const s = fakeSession(opts)
        sessions.push(s)
        return s
      },
      noDriver,
      true,
    )
    await m.start(() => {})
    await waitFor(() => m.running().length === 2)
    const alpha = sessions.find((s) => s.profile === 'alpha')!
    let release = () => {}
    alpha.stop = () => new Promise<void>((r) => (release = r))
    alpha.opts.onAuthExpired!(new Error('AADSTS700082: The refresh token has expired'))
    await tick()
    await m.stopAll()
    release()
    await tick()
    await tick()
    expect(store.get().conn).not.toBe('authError')
    expect(store.get().modal).toBeNull()
  })

  test('a refresh-token expiry mid-session stops only that account; swapping to it shows why', async () => {
    nonSeeded()
    const sessions: FakeSession[] = []
    const { drivers, start: startDriver } = driverRecorder()
    const store = concurrentStore(['alpha', 'beta'])
    const m = createAccountManager(
      store,
      'alpha',
      async (opts) => {
        const s = fakeSession(opts)
        sessions.push(s)
        return s
      },
      startDriver,
      true,
    )
    await m.start(() => {})
    await waitFor(() => m.running().length === 2)
    const session = (p: string) => sessions.filter((s) => s.profile === p).at(-1)!
    expect(session('alpha').opts.labelled?.()).toBe(true)
    // A background session reads the root store's list filter (its own view
    // resets it), so a filter that lifts a collapse also lifts presence.
    store.set({ filter: 'bob' })
    expect(session('beta').opts.listFilter?.()).toBe('bob')
    store.set({ filter: '' })

    // Every loop reports the same expiry; it is handled once.
    const expired = new Error('AADSTS700082: The refresh token has expired')
    session('beta').opts.onAuthExpired!(expired)
    session('beta').opts.onAuthExpired!(expired)
    const beta = () => store.get().backgroundAccounts[accountRef('beta').id]
    await waitFor(() => beta()?.conn === 'authError')
    expect(session('beta').stopped).toBe(true)
    expect(session('alpha').stopped).toBe(false)
    expect(store.get().conn).not.toBe('authError')
    expect(store.get().modal).toBeNull() // beta is in the background
    expect(m.running().map((r) => r.label)).toEqual(['alpha'])
    expect(session('alpha').opts.labelled?.()).toBe(false)
    expect(drivers.filter((d) => !d.ops.includes('stop')).map((d) => d.account)).toEqual(['alpha'])

    // Swapping to it surfaces the expiry instead of an empty pane.
    m.setForeground('beta')
    expect(store.get().modal).toMatchObject({ kind: 'auth-expired', profile: 'beta' })
    expect((store.get().modal as { message: string }).message).toContain('AADSTS700082')
    // A healthy account opens no modal.
    m.setForeground('alpha')
    expect(store.get().modal).toBeNull()

    // retry brings it back.
    await m.retry('beta')
    expect(m.running().map((r) => r.label)).toEqual(['alpha', 'beta'])
    await m.stopAll()
  })

  test('every account in authError: nothing exits, retry recovers one', async () => {
    nonSeeded()
    const held = heldSessions()
    const store = concurrentStore(['alpha', 'beta'])
    const m = createAccountManager(store, 'alpha', held.start, noDriver, true)
    const starting = m.start(() => {})
    await tick()
    held.pending.alpha!.fail(new Error('AADSTS700082: expired'))
    await starting
    await waitFor(() => held.requested.includes('beta'))
    held.pending.beta!.fail(new Error('AADSTS700082: expired'))
    await waitFor(() => store.get().backgroundAccounts[accountRef('beta').id]?.conn === 'authError')
    expect(store.get().conn).toBe('authError')
    expect(store.get().modal?.kind).toBe('auth-expired')
    expect(m.running()).toEqual([])
    const retrying = m.retry('beta')
    await tick()
    held.pending.beta!.release()
    await retrying
    expect(m.running().map((r) => r.label)).toEqual(['beta'])
    await m.stopAll()
  })

  test('single mode passes no concurrent-only session callbacks', async () => {
    nonSeeded()
    const opts: RunSessionOpts[] = []
    const m = createAccountManager(
      createAppStore(),
      'alpha',
      async (o) => {
        opts.push(o)
        return fakeSession(o)
      },
      noDriver,
    )
    await m.start(() => {})
    expect(opts[0]!.onAuthExpired).toBeUndefined()
    expect(opts[0]!.labelled).toBeUndefined()
    expect(opts[0]!.listFilter).toBeUndefined()
    await m.stopAll()
  })

  test('stopAll stops every session in parallel, resets every driver, and is idempotent', async () => {
    nonSeeded()
    const { drivers, start: startDriver } = driverRecorder()
    const log: string[] = []
    const store = concurrentStore(['alpha', 'beta'])
    const m = createAccountManager(
      store,
      'alpha',
      async (opts) => ({
        ...fakeSession(opts),
        stop: async () => {
          log.push(`${opts.profile}:stopping`)
          await Bun.sleep(20)
          log.push(`${opts.profile}:stopped`)
        },
      }),
      startDriver,
      true,
    )
    await m.start(() => {})
    await waitFor(() => m.running().length === 2)
    await Promise.all([m.stopAll(), m.stopAll()])
    await m.stopAll()
    expect(log.slice(0, 2).sort()).toEqual(['alpha:stopping', 'beta:stopping'])
    expect(log).toHaveLength(4)
    expect(drivers.map((d) => [d.account, d.ops])).toEqual([
      ['alpha', ['reset', 'stop']],
      ['beta', ['reset', 'stop']],
    ])
    expect(m.pollerHandleRef.current).toBeNull()
  })

  test('caches persist per account; a foreground swap schedules no write', async () => {
    nonSeeded()
    const sessions: FakeSession[] = []
    const store = concurrentStore(['alpha', 'beta'])
    const m = createAccountManager(
      store,
      'alpha',
      async (opts) => {
        const s = fakeSession(opts)
        sessions.push(s)
        return s
      },
      noDriver,
      true,
    )
    await m.start(() => {})
    await waitFor(() => m.running().length === 2)
    const handle = (p: string) => sessions.find((s) => s.profile === p)!.opts.account
    const alphaPath = getMessageCachePath(process.env, 'alpha')
    const betaPath = getMessageCachePath(process.env, 'beta')
    handle('alpha').set({ messageCacheByConvo: { 'chat:a': emptyMessageCache([msg('m1', 'a')]) } })
    handle('beta').set({ messageCacheByConvo: { 'chat:b': emptyMessageCache([msg('m1', 'b')]) } })
    flushMessageCache()
    expect(Object.keys(loadMessageCache(alphaPath))).toEqual(['chat:a'])
    expect(Object.keys(loadMessageCache(betaPath))).toEqual(['chat:b'])

    rmSync(alphaPath)
    rmSync(betaPath)
    await m.switchAccount('beta')
    await m.switchAccount('alpha')
    flushMessageCache()
    expect(existsSync(alphaPath)).toBe(false)
    expect(existsSync(betaPath)).toBe(false)
    await m.stopAll()
  })

  test('seeded mode: every account gets its fixtures, no sessions', async () => {
    process.env.TEAMINAL_SEED = 'fixtures'
    let starts = 0
    const store = concurrentStore(['alpha', 'beta'])
    const m = createAccountManager(
      store,
      'alpha',
      async (opts) => {
        starts++
        return fakeSession(opts)
      },
      noDriver,
      true,
    )
    await m.start(() => {})
    await waitFor(() => m.running().length === 2)
    const alphaTopic = store.get().chats.find((c) => c.topic)?.topic
    await m.switchAccount('beta')
    expect(store.get().chats.find((c) => c.topic)?.topic).toBe(alphaTopic!.toUpperCase())
    expect(starts).toBe(0)
    await m.stopAll()
  })
  test('two aliases of the same user: one warning per pair, naming both', async () => {
    nonSeeded()
    const sessions: FakeSession[] = []
    const store = concurrentStore(['alpha', 'beta', 'gamma'])
    const users: Record<string, string> = { alpha: 'u-1', beta: 'u-1', gamma: 'u-2' }
    const m = createAccountManager(
      store,
      'alpha',
      async (opts) => {
        opts.account.set({ me: { id: users[opts.profile!]!, displayName: 'Alice' } as never })
        const s = fakeSession(opts)
        sessions.push(s)
        return s
      },
      noDriver,
      true,
    )
    const warnings: string[] = []
    const unsubscribe = subscribeEvents((e) => {
      if (e.level === 'warn' && e.message.includes('same user')) warnings.push(e.message)
    })
    await m.start(() => {})
    await waitFor(() => m.running().length === 3)
    expect(warnings).toEqual([
      'accounts alpha and beta sign in as the same user: both run, each notifies',
    ])
    // A restart of one of them does not warn again.
    accountStoreFor(store, accountRef('beta')).set({ conn: 'offline' })
    await m.retry('beta')
    expect(warnings).toHaveLength(1)
    unsubscribe()

    // r in the diagnostics overview retries the selected account's push.
    m.retryRealtime(accountRef('gamma').id)
    expect(sessions.find((x) => x.profile === 'gamma')!.retries).toBe(1)
    expect(sessions.find((x) => x.profile === 'alpha')!.retries).toBe(0)
    await m.stopAll()
  })
})

describe('mode toggle', () => {
  test('single mode reads the per-profile cache files concurrent mode wrote (nothing to migrate)', async () => {
    nonSeeded()
    const cache = (text: string) =>
      emptyMessageCache([
        {
          id: 'm1',
          createdDateTime: '2026-01-01T00:00:00Z',
          body: { contentType: 'text', content: text },
        },
      ])
    const concurrentRun = concurrentStore(['alpha', 'beta'])
    const m = createAccountManager(
      concurrentRun,
      'alpha',
      async (o) => fakeSession(o),
      noDriver,
      true,
    )
    accountStoreFor(concurrentRun, accountRef('alpha')).set({
      messageCacheByConvo: { 'chat:c1': cache('from alpha') },
    })
    accountStoreFor(concurrentRun, accountRef('beta')).set({
      messageCacheByConvo: { 'chat:c1': cache('from beta') },
    })
    await m.stopAll()

    // Flag off (or --profile): one account, hydrated from the same files.
    for (const p of ['alpha', 'beta']) {
      const store = createAppStore()
      const single = createAccountManager(store, p, async (o) => fakeSession(o), noDriver)
      expect(store.get().messagesByConvo['chat:c1']?.[0]?.body.content).toBe(`from ${p}`)
      await single.stopAll()
    }
  })
})

describe('turned-off accounts (disabledAccounts)', () => {
  const setDisabled = (
    store: ReturnType<typeof createAppStore>,
    disabledAccounts: string[],
    activeAccount?: string | null,
  ) =>
    store.set((s) => ({
      settings: {
        ...s.settings,
        disabledAccounts,
        activeAccount: activeAccount === undefined ? s.settings.activeAccount : activeAccount,
      },
    }))
  const labels = (m: ReturnType<typeof createAccountManager>) =>
    m
      .running()
      .map((r) => r.label)
      .join()

  test('startupProfile: --profile wins; a turned-off activeAccount yields the first enabled one', async () => {
    const { startupProfile } = await import('./accountManager')
    const s = {
      ...createAppStore().get().settings,
      accounts: ['alpha', 'beta', 'gamma'],
      activeAccount: 'alpha',
      disabledAccounts: ['alpha'],
    }
    expect(startupProfile(s, 'alpha')).toBe('alpha')
    expect(startupProfile(s, undefined)).toBe('beta')
    expect(startupProfile({ ...s, disabledAccounts: [] }, undefined)).toBe('alpha')
    expect(startupProfile({ ...s, disabledAccounts: ['beta'] }, undefined)).toBe('alpha')
    expect(startupProfile({ ...s, activeAccount: null }, undefined)).toBeNull()
    // All off: none (single mode then runs the default profile).
    expect(
      startupProfile({ ...s, disabledAccounts: ['alpha', 'beta', 'gamma'] }, undefined),
    ).toBeNull()
  })

  test('off stops and closes the account without deleting anything; on starts it again', async () => {
    nonSeeded()
    saveMessageCacheNow(
      { 'chat:c1': emptyMessageCache([msg('m1', 'beta text')]) },
      getMessageCachePath(process.env, 'beta'),
    )
    const sessions: FakeSession[] = []
    const { drivers, start: startDriver } = driverRecorder()
    const store = concurrentStore(['alpha', 'beta'])
    const kept = {
      chatRoutingByAccount: { beta: 'ic3-only' as const },
      favoritesByAccount: { beta: ['chat:c1'] },
      chatListCollapsedSections: { [`account:${accountRef('beta').id}`]: true },
    }
    store.set((s) => ({ settings: { ...s.settings, ...kept } }))
    const m = createAccountManager(
      store,
      'alpha',
      async (opts) => {
        const s = fakeSession(opts)
        sessions.push(s)
        return s
      },
      startDriver,
      true,
    )
    await m.start(() => {})
    await waitFor(() => m.running().length === 2)
    const betaId = accountRef('beta').id

    setDisabled(store, ['beta'])
    await m.reconcile()
    const first = sessions.find((s) => s.profile === 'beta')!
    expect(first.stopped).toBe(true)
    expect(first.opts.account.isCurrent()).toBe(false)
    expect(drivers.find((d) => d.account === 'beta')!.ops).toEqual(['stop'])
    expect(store.get().backgroundAccounts[betaId]).toBeUndefined()
    expect(store.get().generationById[betaId]).toBeUndefined()
    expect(labels(m)).toBe('alpha')
    expect(store.get().account?.id).toBe(accountRef('alpha').id)
    // Nothing deleted: its place, routing, favorites, collapse state, cache.
    expect(store.get().settings).toMatchObject({ accounts: ['alpha', 'beta'], ...kept })
    expect(existsSync(getMessageCachePath(process.env, 'beta'))).toBe(true)

    setDisabled(store, [])
    await m.reconcile()
    await waitFor(() => m.running().length === 2)
    const second = sessions.filter((s) => s.profile === 'beta')
    expect(second).toHaveLength(2)
    expect(second[1]!.stopped).toBe(false)
    // Hydrated from the cache it kept.
    expect(
      store.get().backgroundAccounts[betaId]?.messagesByConvo['chat:c1']?.[0]?.body.content,
    ).toBe('beta text')
    expect(labels(m)).toBe('alpha,beta')
    await m.stopAll()
  })

  test('off on the foreground moves it to the next enabled account; off on the last leaves the Accounts modal; on brings it back', async () => {
    nonSeeded()
    const sessions: FakeSession[] = []
    const store = concurrentStore(['alpha', 'beta'])
    const m = createAccountManager(
      store,
      'alpha',
      async (opts) => {
        const s = fakeSession(opts)
        sessions.push(s)
        return s
      },
      noDriver,
      true,
    )
    await m.start(() => {})
    await waitFor(() => m.running().length === 2)

    // What the Accounts modal persists: activeAccount moves to the first
    // enabled account with it.
    setDisabled(store, ['alpha'], 'beta')
    await m.reconcile()
    expect(store.get().account?.id).toBe(accountRef('beta').id)
    expect(m.activeProfile()).toBe('beta')
    expect(m.pollerHandleRef.current).toBe(sessions.find((s) => s.profile === 'beta')!.poller)
    expect(labels(m)).toBe('beta')
    expect(store.get().modal).toBeNull()

    // The remove-all path: no account, no session, the Accounts modal open.
    setDisabled(store, ['alpha', 'beta'], null)
    await m.reconcile()
    expect(store.get().account).toBeNull()
    expect(store.get().modal?.kind).toBe('accounts')
    expect(m.running()).toEqual([])
    expect(m.activeProfile()).toBeNull()
    expect(sessions.every((s) => s.stopped)).toBe(true)

    setDisabled(store, ['beta'])
    await m.reconcile()
    await waitFor(() => m.running().length === 1)
    expect(store.get().account?.id).toBe(accountRef('alpha').id)
    expect(m.activeProfile()).toBe('alpha')
    await m.stopAll()
  })

  test('startup: a turned-off activeAccount is skipped; every account off opens no slot and the Accounts modal', async () => {
    nonSeeded()
    const store = concurrentStore(['alpha', 'beta', 'gamma'], 'alpha')
    setDisabled(store, ['alpha', 'gamma'])
    const m = createAccountManager(store, 'alpha', instant, noDriver, true)
    expect(store.get().account?.id).toBe(accountRef('beta').id)
    expect(store.get().backgroundAccounts).toEqual({})
    await m.start(() => {})
    await waitFor(() => labels(m) === 'beta')
    await m.stopAll()

    const none = concurrentStore(['alpha'])
    setDisabled(none, ['alpha'])
    const requested: string[] = []
    const n = createAccountManager(
      none,
      'alpha',
      async (opts) => {
        requested.push(String(opts.profile))
        return fakeSession(opts)
      },
      noDriver,
      true,
    )
    expect(none.get().account).toBeNull()
    expect(none.get().modal?.kind).toBe('accounts')
    expect(n.activeProfile()).toBeNull()
    await n.start(() => {})
    expect(requested).toEqual([])
    // Turning it on starts it in front, no restart.
    setDisabled(none, [])
    await n.reconcile()
    await waitFor(() => labels(n) === 'alpha')
    expect(none.get().account?.id).toBe(accountRef('alpha').id)
    await n.stopAll()
  })

  test('off then on while its stop hangs: the old session is stopped, one new one runs', async () => {
    nonSeeded()
    managerTimings.stopBoundMs = 30
    const sessions: FakeSession[] = []
    const store = concurrentStore(['alpha', 'beta'])
    const m = createAccountManager(
      store,
      'alpha',
      async (opts) => {
        const s = fakeSession(opts)
        if (opts.profile === 'beta' && sessions.every((x) => x.profile !== 'beta')) {
          s.stop = () => {
            s.stopped = true
            return new Promise(() => {})
          }
        }
        sessions.push(s)
        return s
      },
      noDriver,
      true,
    )
    await m.start(() => {})
    await waitFor(() => m.running().length === 2)
    setDisabled(store, ['beta'])
    const off = m.reconcile()
    await tick()
    setDisabled(store, [])
    const on = m.reconcile()
    await Promise.all([off, on])
    await waitFor(() => labels(m) === 'alpha,beta')
    const betas = sessions.filter((s) => s.profile === 'beta')
    expect(betas.map((s) => s.stopped)).toEqual([true, false])
    expect(m.running().filter((r) => r.label === 'beta')).toHaveLength(1)
    await m.stopAll()
  })

  test('off then on while its start hangs: the late first bootstrap is discarded, the second runs', async () => {
    nonSeeded()
    const held = heldSessions()
    const store = concurrentStore(['alpha', 'beta'])
    const m = createAccountManager(store, 'alpha', held.start, noDriver, true)
    const starting = m.start(() => {})
    await tick()
    held.pending.alpha!.release()
    await starting
    await waitFor(() => held.requested.includes('beta'))
    const firstBeta = held.pending.beta!
    setDisabled(store, ['beta'])
    await m.reconcile()
    setDisabled(store, [])
    await m.reconcile()
    await waitFor(() => held.requested.filter((p) => p === 'beta').length === 2)
    held.pending.beta!.release()
    await waitFor(() => labels(m) === 'alpha,beta')
    firstBeta.release()
    await tick()
    await tick()
    const betas = held.sessions.filter((s) => s.profile === 'beta')
    expect(betas).toHaveLength(2)
    // The second one runs; the first landed late and was stopped.
    expect(betas.map((s) => s.stopped)).toEqual([false, true])
    expect(labels(m)).toBe('alpha,beta')
    await m.stopAll()
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(2)
  }
  throw new Error('waitFor timed out')
}
