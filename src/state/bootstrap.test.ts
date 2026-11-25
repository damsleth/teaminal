import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { createAccountManager, type AccountManager } from './accountManager'
import { accountStore, openAccount } from './accountStore'
import type { RealtimeTransport, TransportOpts, TransportState } from '../realtime/transport'
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

// A push transport that never touches the network; it keeps the bus its
// session handed it so the test can emit events on that session only.
class FakeTransport implements RealtimeTransport {
  state: TransportState = 'disconnected'
  disconnected = false
  constructor(readonly opts: TransportOpts) {}
  async connect(): Promise<void> {
    this.state = 'connected'
  }
  disconnect(): void {
    this.disconnected = true
    this.state = 'disconnected'
  }
  onStateChange(): () => void {
    return () => {}
  }
  retry(): void {}
}

const listPolls = (from: number, who: string) =>
  requests.slice(from).filter((r) => r.who === who && r.url.includes('/v1.0/chats?')).length

describe('runSession', () => {
  test('two sessions in one process: own slots, pollers and transports', async () => {
    install()
    const store = createAppStore(alice)
    store.set({ settings: { ...store.get().settings, realtimeEnabled: true } })
    const a = accountStore(store)
    const b = openAccount(store, bob, { foreground: false })
    const fakes: FakeTransport[] = []
    const createTransport = (o: TransportOpts) => {
      const t = new FakeTransport(o)
      fakes.push(t)
      return t
    }
    const onFatal = () => {}
    const sa = await runSession({ account: a, profile: 'alice', onFatal, createTransport })
    sessions.push(sa)
    const sb = await runSession({ account: b, profile: 'bob', onFatal, createTransport })
    sessions.push(sb)
    const [ta, tb] = fakes

    expect(store.get().me?.id).toBe('alice-id')
    expect(store.get().backgroundAccounts[bob.id]?.me?.id).toBe('bob-id')
    expect(sa.poller).not.toBeNull()
    expect(sa.poller).not.toBe(sb.poller)
    expect(sa.transport).toBe(ta!)
    expect(sb.transport).toBe(tb!)
    expect(ta!.opts.profile).toBe('alice')
    expect(tb!.opts.profile).toBe('bob')

    // Let both initial list polls finish.
    await waitFor(() => listPolls(0, 'alice-id') > 0 && listPolls(0, 'bob-id') > 0)
    await Bun.sleep(50)

    // A push on B's bus wakes B's poller only.
    let mark = requests.length
    tb!.opts.bus.emit({ kind: 'new-message', chatId: 'c1' })
    await waitFor(() => listPolls(mark, 'bob-id') > 0)
    expect(listPolls(mark, 'alice-id')).toBe(0)

    // Stopping A disconnects A's transport only; B's poller still answers.
    await sa.stop()
    sessions.splice(sessions.indexOf(sa), 1)
    expect(ta!.disconnected).toBe(true)
    expect(tb!.disconnected).toBe(false)
    mark = requests.length
    tb!.opts.bus.emit({ kind: 'new-message', chatId: 'c1' })
    await waitFor(() => listPolls(mark, 'bob-id') > 0)
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

// ---- concurrent sessions end to end (M2 E.4) ------------------------------

// One chat, c1, in both accounts (colliding ids). Its preview and newest
// message come from Carol; `preview` per account is the message id the
// next list / message read returns, `topic` the chat topic.
type Answer = { preview: string; topic: string; listStatus?: number }
let answers: Record<string, Answer> = {}
let hold = false
let held: { who: string; release: () => void }[] = []

const carol = { user: { id: 'carol-id', displayName: 'Carol' } }
function respond(who: string, url: string): Response {
  const a = answers[who]!
  if (/\/v1\.0\/me(\?|$)/.test(url)) {
    return json({ id: who, displayName: who, userPrincipalName: `${who}@example.com`, mail: null })
  }
  const message = {
    id: a.preview,
    createdDateTime: '2026-01-01T00:00:00Z',
    chatId: 'c1',
    messageType: 'message',
    body: { contentType: 'text', content: `${a.topic} says hi` },
    from: carol,
  }
  if (url.includes('/v1.0/chats/c1/messages')) return json({ value: [message] })
  if (url.includes('/v1.0/chats?')) {
    if (a.listStatus) return json({ error: { message: 'nope' } }, a.listStatus)
    return json({
      value: [
        {
          id: 'c1',
          chatType: 'group',
          topic: a.topic,
          createdDateTime: '2026-01-01T00:00:00Z',
          lastMessagePreview: { ...message, chatId: undefined },
        },
      ],
    })
  }
  if (url.includes('/v1.0/me/joinedTeams')) return json({ value: [] })
  return json({ error: { message: 'not here' } }, 404)
}

let cacheRoot = ''
const realXdg = process.env.XDG_CACHE_HOME
const realSeed = process.env.TEAMINAL_SEED
const managers: AccountManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.stopAll()
  hold = false
  for (const h of held.splice(0)) h.release()
  if (realXdg === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = realXdg
  if (realSeed === undefined) delete process.env.TEAMINAL_SEED
  else process.env.TEAMINAL_SEED = realSeed
  if (cacheRoot) rmSync(cacheRoot, { recursive: true, force: true })
  cacheRoot = ''
})

// Two real sessions (alice in front, bob behind) on the fake transports.
async function startConcurrent() {
  install()
  answers = {
    'alice-id': { preview: 'a1', topic: 'alice topic' },
    'bob-id': { preview: 'b1', topic: 'bob topic' },
  }
  graphClient.__setTransportForTests(async (url, init) => {
    const who = oidOf(init)
    requests.push({ who, url })
    if (!hold) return respond(who, url)
    // Held requests ignore abort, like a server that answers late.
    return new Promise((resolve) => held.push({ who, release: () => resolve(respond(who, url)) }))
  })
  delete process.env.TEAMINAL_SEED
  cacheRoot = mkdtempSync(join(tmpdir(), 'teaminal-concurrent-'))
  process.env.XDG_CACHE_HOME = cacheRoot
  const store = createAppStore()
  store.set((s) => ({
    settings: {
      ...s.settings,
      accounts: ['alice', 'bob'],
      activeAccount: 'alice',
      concurrentAccounts: true,
      realtimeEnabled: true,
      // Plain messages raise no notification (no banner from a test run).
      notifyChatMessages: false,
    },
  }))
  const transports: Record<string, FakeTransport> = {}
  const m = createAccountManager(
    store,
    'alice',
    (opts) =>
      runSession({
        ...opts,
        createTransport: (o) => (transports[String(o.profile)] = new FakeTransport(o)),
      }),
    () => ({ stop() {}, async reset() {} }),
    true,
  )
  managers.push(m)
  await m.start(() => {})
  const bobSlice = () => store.get().backgroundAccounts[bob.id]
  await waitFor(() => store.get().chats.length === 1 && bobSlice()?.chats.length === 1)
  const wake = (p: string) => transports[p]!.opts.bus.emit({ kind: 'new-message', chatId: 'c1' })
  return { store, m, wake }
}

describe('concurrent sessions', () => {
  test("a message in A's remembered chat while B is in front: unread, then read on the swap back", async () => {
    const { store, m, wake } = await startConcurrent()
    store.set({ focus: { kind: 'chat', chatId: 'c1' } })
    await waitFor(() =>
      requests.some((r) => r.who === 'alice-id' && r.url.includes('/c1/messages')),
    )

    await m.switchAccount('bob')
    const aliceSlice = () => store.get().backgroundAccounts[alice.id]!
    expect(store.get().focus).toEqual({ kind: 'list' })
    answers['alice-id']!.preview = 'a2'
    wake('alice')
    // Alice's view has list focus while bob is in front, so the new
    // message counts as unread there.
    await waitFor(() => (aliceSlice().unreadByChatId.c1?.unreadCount ?? 0) > 0)
    expect(store.get().unreadByChatId.c1?.unreadCount ?? 0).toBe(0)

    await m.switchAccount('alice')
    expect(store.get().focus).toEqual({ kind: 'chat', chatId: 'c1' })
    await waitFor(() => store.get().unreadByChatId.c1?.unreadCount === 0)
  })

  test("late reads from a stopped account are dropped; B's writes land in B", async () => {
    const { store, m, wake } = await startConcurrent()
    hold = true
    wake('alice')
    wake('bob')
    await waitFor(
      () => held.some((h) => h.who === 'alice-id') && held.some((h) => h.who === 'bob-id'),
    )
    await m.switchAccount('bob')
    await m.switchAccount('alice')
    answers['alice-id']!.topic = 'alice late'
    answers['bob-id']!.topic = 'bob late'
    // Remove alice while her reads hang (her session's stop is bounded).
    store.set((s) => ({ settings: { ...s.settings, accounts: ['bob'], activeAccount: 'bob' } }))
    await m.reconcile()
    expect(store.get().account?.id).toBe(bob.id)
    hold = false
    for (const h of held.splice(0).reverse()) h.release()
    await waitFor(() => store.get().chats[0]?.topic === 'bob late')
    await Bun.sleep(50)
    const s = store.get()
    expect(s.backgroundAccounts[alice.id]).toBeUndefined()
    expect(JSON.stringify(s)).not.toContain('alice')
  }, 10_000)

  test("A's 401 leaves B's conn, latch and poller alone", async () => {
    const { store, m, wake } = await startConcurrent()
    const bobSlice = () => store.get().backgroundAccounts[bob.id]!
    await waitFor(() => store.get().conn === 'online' && bobSlice().conn === 'online')
    // Graph 401 on alice's list: her poller latches to Teams CSA (404 here)
    // and goes offline.
    answers['alice-id']!.listStatus = 401
    wake('alice')
    await waitFor(() => store.get().conn === 'offline')
    expect(bobSlice().conn).toBe('online')
    // Bob's poller still answers, still on Graph (the latch is alice's).
    const mark = requests.length
    wake('bob')
    await waitFor(() => listPolls(mark, 'bob-id') > 0)
    expect(bobSlice().conn).toBe('online')
    expect(m.running().map((r) => r.label)).toEqual(['alice', 'bob'])
  })
})
