import { afterEach, describe, expect, test } from 'bun:test'
import { accountRef } from '../account'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'
import {
  __resetForTests as resetPresence,
  __setTransportForTests as setPresenceTransport,
} from '../graph/teamsPresence'
import { accountStore, closeAccount, openAccount } from './accountStore'
import { startForceAvailabilityDriver, type ForceAvailabilityHandle } from './forceAvailability'
import { createAppStore } from './store'

const alice = accountRef('alice')
const bob = accountRef('bob')
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600

function makeJwt(payload: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  return `${enc({ alg: 'none', typ: 'JWT' })}.${enc(payload)}.sig`
}

// The token names the profile it was minted for, so each presence call can
// be attributed to its account.
function oidOf(init: RequestInit): string {
  const auth = (init.headers as Record<string, string>).Authorization ?? ''
  const payload = auth.replace('Bearer ', '').split('.')[1] ?? ''
  return (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { oid: string }).oid
}

type Call = { who: string; kind: 'endpoint' | 'force'; body: Record<string, string> }
let calls: Call[] = []
const denied = new Set<string>()
const drivers: ForceAvailabilityHandle[] = []

function install(): void {
  setAuthRunner(async (args) => {
    const i = args.indexOf('--profile')
    const profile = i >= 0 ? args[i + 1] : 'default'
    return { stdout: makeJwt({ exp: FAR_FUTURE, oid: `${profile}-id` }), stderr: '', exitCode: 0 }
  })
  setPresenceTransport(async (url, init) => {
    const who = oidOf(init)
    calls.push({
      who,
      kind: url.includes('/endpoints/') ? 'endpoint' : 'force',
      body: JSON.parse(String(init.body)),
    })
    if (denied.has(who)) return new Response('forbidden', { status: 403 })
    return new Response(null, { status: 201 })
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error('waitFor timed out')
}

afterEach(() => {
  for (const d of drivers.splice(0)) d.stop()
  calls = []
  denied.clear()
  resetAuth()
  resetPresence()
})

describe('force-availability driver per account', () => {
  test('two drivers register different endpoints; a 403 on A latches only A', async () => {
    install()
    denied.add('alice-id')
    const store = createAppStore(alice)
    const a = accountStore(store)
    const b = openAccount(store, bob, { foreground: false })
    drivers.push(startForceAvailabilityDriver(a), startForceAvailabilityDriver(b))

    // A fresh driver fires right away.
    await waitFor(
      () =>
        calls.some((c) => c.who === 'alice-id') &&
        calls.some((c) => c.who === 'bob-id' && c.kind === 'force'),
    )
    const endpoints = calls.filter((c) => c.kind === 'endpoint')
    expect(new Set(endpoints.map((c) => c.body.id)).size).toBe(2)
    expect(new Set(endpoints.map((c) => c.who))).toEqual(new Set(['alice-id', 'bob-id']))
    // Mirrored into B's own slice only.
    await waitFor(() => store.get().backgroundAccounts[bob.id]?.myPresence !== undefined)
    expect(store.get().myPresence).toBeUndefined()

    // A picked presence (one global value) re-fires B; A stays latched off.
    calls = []
    store.set({ presenceChoice: 'Busy' })
    await waitFor(() =>
      calls.some((c) => c.who === 'bob-id' && c.kind === 'force' && c.body.availability === 'Busy'),
    )
    await Bun.sleep(20)
    expect(calls.some((c) => c.who === 'alice-id')).toBe(false)
    await waitFor(() => store.get().backgroundAccounts[bob.id]?.myPresence?.availability === 'Busy')

    // reset() puts its own account back to Available; the latched one is skipped.
    calls = []
    await drivers[0]!.reset()
    await drivers[1]!.reset()
    expect(calls.map((c) => [c.who, c.body.availability])).toEqual([['bob-id', 'Available']])
  })

  test('a driver stops reacting once its slot is closed', async () => {
    install()
    const store = createAppStore(alice)
    const b = openAccount(store, bob, { foreground: false })
    drivers.push(startForceAvailabilityDriver(b))
    await waitFor(() => calls.some((c) => c.kind === 'force'))
    closeAccount(store, bob.id)
    calls = []
    store.set({ presenceChoice: 'Busy' })
    await Bun.sleep(20)
    expect(calls).toEqual([])
  })
})
