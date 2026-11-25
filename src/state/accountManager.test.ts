import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountRef } from '../account'
import { createAccountManager } from './accountManager'
import type { AccountStore } from './accountStore'
import type { RunSessionOpts, SessionHandle } from './bootstrap'
import type { ForceAvailabilityHandle } from './forceAvailability'
import type { PollerHandle } from './poller'
import { getMessageCachePath, loadMessageCache } from './messageCachePersistence'
import { createAppStore, emptyMessageCache, resetAccountScopedState } from './store'

const realSeed = process.env.TEAMINAL_SEED
const realXdg = process.env.XDG_CACHE_HOME
let cacheRoot = ''

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
