import { afterEach, describe, expect, test } from 'bun:test'
import { accountRef } from '../account'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'
import * as graphClient from '../graph/client'
import * as teamsActivity from '../graph/teamsActivity'
import * as teamsAsyncGw from '../graph/teamsAsyncGw'
import * as teamsChatsvc from '../graph/teamsChatsvc'
import * as teamsCsa from '../graph/teamsCsa'
import * as teamsExternalSearch from '../graph/teamsExternalSearch'
import * as teamsFederation from '../graph/teamsFederation'
import * as teamsPresence from '../graph/teamsPresence'
import { __resetForTests as resetRegion, __setRegionForTests } from '../graph/teamsRegion'
import { accountStore, openAccount } from './accountStore'
import { runSession, type SessionHandle } from './bootstrap'
import { createAppStore } from './store'

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600
const alice = accountRef('alice')
const bob = accountRef('bob')

function makeJwt(payload: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  return `${enc({ alg: 'none', typ: 'JWT' })}.${enc(payload)}.sig`
}

// Tokens name the profile they were minted for, so every request can be
// attributed to its account.
function oidOf(init: RequestInit): string {
  const headers = new Headers(init.headers)
  const payload = (headers.get('Authorization') ?? '').split('.')[1] ?? ''
  if (!payload) return 'unknown'
  return (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { oid: string }).oid
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type Req = { who: string; url: string }
let requests: Req[] = []
const sessions: SessionHandle[] = []

// The Teams-service modules never reach the network in this test.
const serviceModules = [
  teamsActivity,
  teamsAsyncGw,
  teamsChatsvc,
  teamsCsa,
  teamsExternalSearch,
  teamsFederation,
  teamsPresence,
]

function install(): void {
  setAuthRunner(async (args) => {
    const i = args.indexOf('--profile')
    const profile = i >= 0 ? args[i + 1] : 'default'
    return { stdout: makeJwt({ exp: FAR_FUTURE, oid: `${profile}-id` }), stderr: '', exitCode: 0 }
  })
  for (const p of ['alice', 'bob']) __setRegionForTests(p, 'emea')
  for (const m of serviceModules) {
    m.__setTransportForTests(async () => json({ error: { message: 'not here' } }, 404))
  }
  // Presence reads answer with nobody, so the presence loop stays quiet.
  teamsPresence.__setTransportForTests(async () => json([]))
  graphClient.__setTransportForTests(async (url, init) => {
    const who = oidOf(init)
    requests.push({ who, url })
    if (/\/v1\.0\/me(\?|$)/.test(url)) {
      return json({
        id: who,
        displayName: who,
        userPrincipalName: `${who}@example.com`,
        mail: null,
      })
    }
    if (url.includes('/v1.0/chats') || url.includes('/v1.0/me/joinedTeams')) {
      return json({ value: [] })
    }
    return json({ error: { message: 'not here' } }, 404)
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error('waitFor timed out')
}

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop()
  requests = []
  graphClient.__resetForTests()
  for (const m of serviceModules) m.__resetForTests()
  resetRegion()
  resetAuth()
})

describe('runSession', () => {
  test('two sessions in one process write their own slots and own their pollers', async () => {
    install()
    const store = createAppStore(alice)
    const a = accountStore(store)
    const b = openAccount(store, bob, { foreground: false })
    const sa = await runSession({ account: a, profile: 'alice', onFatal: () => {} })
    sessions.push(sa)
    const sb = await runSession({ account: b, profile: 'bob', onFatal: () => {} })
    sessions.push(sb)

    expect(store.get().me?.id).toBe('alice-id')
    expect(store.get().backgroundAccounts[bob.id]?.me?.id).toBe('bob-id')
    expect(sa.poller).not.toBeNull()
    expect(sb.poller).not.toBeNull()
    expect(sa.poller).not.toBe(sb.poller)
    // Realtime is off by default: no transport.
    expect(sa.transport).toBeNull()

    // Stopping A leaves B's poller running.
    await sa.stop()
    sessions.splice(sessions.indexOf(sa), 1)
    const mark = requests.length
    sb.poller!.refresh()
    await waitFor(() =>
      requests.slice(mark).some((r) => r.who === 'bob-id' && r.url.includes('/v1.0/chats')),
    )
    expect(requests.slice(mark).some((r) => r.who === 'alice-id')).toBe(false)
  })

  test('a session refuses a handle for another account', async () => {
    install()
    const store = createAppStore(alice)
    await expect(
      runSession({ account: accountStore(store), profile: 'bob', onFatal: () => {} }),
    ).rejects.toThrow('another account')
  })
})
