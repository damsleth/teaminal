// Split panes in the poller: one active loop per pane side, sharing the
// seen-set and the 403 latch. Chats go through the Graph test transport;
// channel and thread pages (Teams chat service) are stubbed per test.

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { accountRef } from '../account'
import { accountStore, openAccount } from './accountStore'
import {
  __resetForTests,
  __setTransportForTests,
  createGraphClient,
  type AccountContext,
} from '../graph/client'
import { __setBackoffSleepForTests } from '../graph/backoff'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'
import type { Chat, ChatMessage, Mention } from '../types'
import { createAppStore, type Focus } from './store'

// Channel / thread pages: a per-test handler, else the real module.
type Page = { messages: ChatMessage[]; nextLink?: string }
let channelPage: ((focus: Focus, signal?: AbortSignal) => Promise<Page>) | null = null
let channelNext: ((nextLink: string) => Promise<Page>) | null = null
const realTeams = await import('../graph/teams')
mock.module('../graph/teams', () => ({
  ...realTeams,
  listChannelMessagesPage: (
    client: unknown,
    teamId: string,
    channelId: string,
    opts?: { signal?: AbortSignal },
  ) =>
    channelPage
      ? channelPage({ kind: 'channel', teamId, channelId }, opts?.signal)
      : realTeams.listChannelMessagesPage(
          client as Parameters<typeof realTeams.listChannelMessagesPage>[0],
          teamId,
          channelId,
          opts,
        ),
  listChannelMessagesNextPage: (
    client: unknown,
    nextLink: string,
    opts?: { signal?: AbortSignal },
  ) =>
    channelNext
      ? channelNext(nextLink)
      : realTeams.listChannelMessagesNextPage(
          client as Parameters<typeof realTeams.listChannelMessagesNextPage>[0],
          nextLink,
          opts,
        ),
  listChannelRepliesPage: (
    client: unknown,
    teamId: string,
    channelId: string,
    rootId: string,
    opts?: { signal?: AbortSignal },
  ) =>
    channelPage
      ? channelPage({ kind: 'thread', teamId, channelId, rootId }, opts?.signal)
      : realTeams.listChannelRepliesPage(
          client as Parameters<typeof realTeams.listChannelRepliesPage>[0],
          teamId,
          channelId,
          rootId,
          opts,
        ),
}))
const { startPoller } = await import('./poller')
const { closeOtherPane, switchPane } = await import('./panes')
type PollerHandle = ReturnType<typeof startPoller>
type MentionEvent = Parameters<NonNullable<Parameters<typeof startPoller>[0]['onMention']>>[0]

const testClient = (over: Partial<AccountContext> = {}) =>
  createGraphClient({ account: accountRef(undefined), audience: 'graph', fallback: false, ...over })

const ME = {
  id: 'me-id',
  displayName: 'Kari Nordmann',
  userPrincipalName: 'kari@example.com',
  mail: null,
}
const A: Focus = { kind: 'chat', chatId: 'chat-a' }
const B: Focus = { kind: 'chat', chatId: 'design' }
const LIST: Focus = { kind: 'list' }

function primeAuth(): void {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const exp = Math.floor(Date.now() / 1000) + 3600
  setAuthRunner(async () => ({
    stdout: `${b64({ alg: 'none' })}.${b64({ exp, oid: ME.id })}.sig`,
    stderr: '',
    exitCode: 0,
  }))
}

const message = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  createdDateTime: '2026-04-29T09:00:00Z',
  body: { contentType: 'text', content: id },
  from: { user: { id: 'u-alice', displayName: 'Alice Nordmann' } },
  ...extra,
})
const mentionsMe: Mention[] = [
  { id: 0, mentionText: '@Kari', mentioned: { user: { id: ME.id, displayName: 'Kari' } } },
]

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await Bun.sleep(5)
  }
}

// Resolves never; rejects when `signal` aborts (what fetch does).
const hangUntilAborted = (signal?: AbortSignal | null) =>
  new Promise<never>((_, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  })

type ChatHandler = (chatId: string, init: RequestInit) => Response | Promise<Response>
let chatsList: () => Chat[] = () => []

function installChats(onMessages: ChatHandler): void {
  __setTransportForTests(async (url, init) => {
    const m = url.match(/\/v1\.0\/chats\/([^/]+)\/messages/)
    if (m) return onMessages(decodeURIComponent(m[1]!), init)
    if (url.includes('/v1.0/chats?')) return Response.json({ value: chatsList() })
    if (url.endsWith('/me/joinedTeams')) return Response.json({ value: [] })
    if (url.endsWith('/me/presence')) return Response.json({ availability: 'Available' })
    return Response.json({ value: [] })
  })
}

let handle: PollerHandle | null = null
afterEach(async () => {
  if (handle) await handle.stop()
  handle = null
  channelPage = null
  channelNext = null
  chatsList = () => []
  __setBackoffSleepForTests(null)
  __resetForTests()
  resetAuth()
})

function start(
  focus: Focus,
  split: { focus: Focus; side: 'left' | 'right' } | null,
  opts: {
    activeMs?: number
    listMs?: number
    shown?: boolean
    onMention?: (e: MentionEvent) => void
  } = {},
) {
  const store = createAppStore(accountRef('test'))
  store.set({ me: ME, focus, split, splitShown: opts.shown ?? false })
  const errors: Error[] = []
  handle = startPoller({
    getClient: testClient,
    store: accountStore(store),
    intervals: {
      activeMs: opts.activeMs ?? 60_000,
      listMs: opts.listMs ?? 99_999,
      presenceMs: 99_999,
    },
    onMention: opts.onMention,
    onError: (_loop, err) => errors.push(err),
  })
  return { store, errors }
}

describe('split panes: per-side active loops', () => {
  test('both conversations are fetched', async () => {
    primeAuth()
    const calls: string[] = []
    installChats((chatId) => {
      calls.push(chatId)
      return Response.json({ value: [message(`${chatId}-1`)] })
    })
    const { store } = start(A, { focus: B, side: 'right' })
    await waitFor(() => calls.length >= 2)
    await waitFor(() => !!store.get().messagesByConvo['chat:design'])
    expect(calls.sort()).toEqual(['chat-a', 'design'])
    expect(store.get().messagesByConvo['chat:chat-a']).toHaveLength(1)
  })

  test('switching panes costs no fetch within one interval', async () => {
    primeAuth()
    const calls: string[] = []
    installChats((chatId) => {
      calls.push(chatId)
      return Response.json({ value: [message(`${chatId}-1`)] })
    })
    // Both panes on screen (App publishes this from the layout).
    const { store } = start(A, { focus: B, side: 'right' }, { shown: true })
    await waitFor(() => calls.length === 2)
    store.set((s) => switchPane(s))
    expect(store.get().focus).toEqual(B)
    await Bun.sleep(150)
    store.set((s) => switchPane(s))
    await Bun.sleep(150)
    expect(calls).toHaveLength(2)
  })

  test('closing the split stops the removed target on either side', async () => {
    primeAuth()
    const calls: string[] = []
    installChats((chatId) => {
      calls.push(chatId)
      return Response.json({ value: [message(`${chatId}-1`)] })
    })
    // The passive pane on the right goes away.
    const { store } = start(A, { focus: B, side: 'right' })
    await waitFor(() => calls.length === 2)
    store.set((s) => closeOtherPane(s))
    calls.length = 0
    handle!.refresh()
    await waitFor(() => calls.length >= 1)
    await Bun.sleep(100)
    expect(calls).toEqual(['chat-a'])
  })

  test('closing from an empty active pane keeps the other conversation on one loop', async () => {
    primeAuth()
    const calls: string[] = []
    installChats((chatId) => {
      calls.push(chatId)
      return Response.json({ value: [message(`${chatId}-1`)] })
    })
    const { store } = start(LIST, { focus: B, side: 'right' })
    await waitFor(() => calls.length === 1)
    store.set((s) => closeOtherPane(s))
    // Design moves from the right loop to the left one: one refetch there.
    await waitFor(() => calls.length === 2)
    calls.length = 0
    handle!.refresh()
    await waitFor(() => calls.length >= 1)
    await Bun.sleep(100)
    expect(calls).toEqual(['design'])
  })

  test('refresh wakes both sides; stop resolves with a right-side fetch in flight', async () => {
    primeAuth()
    const calls: string[] = []
    let hangDesign = false
    installChats((chatId, init) => {
      calls.push(chatId)
      if (chatId === 'design' && hangDesign) return hangUntilAborted(init.signal)
      return Response.json({ value: [message(`${chatId}-1`)] })
    })
    start(A, { focus: B, side: 'right' })
    await waitFor(() => calls.length === 2)
    hangDesign = true
    handle!.refresh()
    await waitFor(() => calls.length === 4)
    expect(calls.slice(2).sort()).toEqual(['chat-a', 'design'])
    const stopped = handle!.stop()
    handle = null
    const result = await Promise.race([stopped.then(() => 'stopped'), Bun.sleep(1_000)])
    expect(result).toBe('stopped')
  })

  test('a 403 on one side blocks that conversation only, in either pane', async () => {
    primeAuth()
    const calls: string[] = []
    installChats((chatId) => {
      calls.push(chatId)
      if (chatId === 'design') return Response.json({ error: { message: 'no' } }, { status: 403 })
      return Response.json({ value: [message(`${chatId}-1`)] })
    })
    const { store } = start(A, { focus: B, side: 'right' }, { activeMs: 30 })
    await waitFor(() => calls.filter((c) => c === 'chat-a').length >= 3)
    expect(calls.filter((c) => c === 'design')).toHaveLength(1)
    // Moving the blocked conversation to the other side does not retry it.
    store.set((s) => switchPane(s))
    store.set((s) => closeOtherPane(s))
    expect(store.get().focus).toEqual(B)
    await Bun.sleep(150)
    expect(calls.filter((c) => c === 'design')).toHaveLength(1)
  })

  test('a target change aborts that side only; the other side still applies', async () => {
    primeAuth()
    let releaseA!: () => void
    const gateA = new Promise<void>((r) => (releaseA = r))
    const aborted: string[] = []
    installChats(async (chatId, init) => {
      if (chatId === 'chat-a') await gateA
      if (chatId === 'design') {
        init.signal?.addEventListener('abort', () => aborted.push(chatId))
        return hangUntilAborted(init.signal)
      }
      return Response.json({ value: [message(`${chatId}-1`)] })
    })
    const { store } = start(A, { focus: B, side: 'right' })
    await Bun.sleep(50)
    // The right side moves to another conversation mid-fetch.
    store.set({ split: { focus: { kind: 'chat', chatId: 'ops' }, side: 'right' } })
    await waitFor(() => aborted.length === 1)
    releaseA()
    await waitFor(() => !!store.get().messagesByConvo['chat:chat-a'])
    await waitFor(() => !!store.get().messagesByConvo['chat:ops'])
    expect(store.get().messagesByConvo['chat:design']).toBeUndefined()
  })

  test('a late page after close and reopen, or a hard refresh, is not applied', async () => {
    primeAuth()
    let release!: () => void
    let gate = new Promise<void>((r) => (release = r))
    let designCalls = 0
    installChats(async (chatId) => {
      if (chatId === 'design') {
        designCalls++
        // The first design fetch ignores its abort signal and resolves late.
        if (designCalls === 1) await gate
      }
      return Response.json({ value: [message(`${chatId}-${designCalls}`)] })
    })
    const { store } = start(A, { focus: B, side: 'right' })
    await waitFor(() => designCalls === 1)
    store.set((s) => closeOtherPane(s))
    store.set({ split: { focus: B, side: 'right' } })
    handle!.hardRefresh()
    release()
    await waitFor(() => !!store.get().messagesByConvo['chat:design'])
    expect(store.get().messagesByConvo['chat:design']!.map((m) => m.id)).toEqual(['design-2'])
    gate = Promise.resolve()
  })

  test('429s exhausting on one side back that side off; the other keeps polling', async () => {
    primeAuth()
    __setBackoffSleepForTests(async () => {})
    const calls: string[] = []
    installChats((chatId) => {
      calls.push(chatId)
      if (chatId === 'design')
        return new Response('{}', { status: 429, headers: { 'Retry-After': '0' } })
      return Response.json({ value: [message(`${chatId}-1`)] })
    })
    const { store, errors } = start(A, { focus: B, side: 'right' }, { activeMs: 30 })
    await waitFor(() => calls.filter((c) => c === 'chat-a').length >= 4)
    // One exhausted call is 1 + MAX_429_RETRIES requests, then backoff.
    expect(errors.some((e) => /rate limited/.test(e.message))).toBe(true)
    expect(store.get().messagesByConvo['chat:design']).toBeUndefined()
    expect(store.get().messagesByConvo['chat:chat-a']).toHaveLength(1)
  })

  test('stop during a 429 retry wait resolves', async () => {
    primeAuth()
    let designCalls = 0
    installChats((chatId) => {
      if (chatId === 'design') {
        designCalls++
        return new Response('{}', { status: 429, headers: { 'Retry-After': '30' } })
      }
      return Response.json({ value: [message(`${chatId}-1`)] })
    })
    start(A, { focus: B, side: 'right' })
    await waitFor(() => designCalls === 1)
    const stopped = handle!.stop()
    handle = null
    const result = await Promise.race([stopped.then(() => 'stopped'), Bun.sleep(1_000)])
    expect(result).toBe('stopped')
  })
})

describe('split panes: background accounts', () => {
  test('a foreground split never makes a background session poll its conversations', async () => {
    primeAuth()
    const calls: string[] = []
    installChats((chatId) => {
      calls.push(chatId)
      return Response.json({ value: [message(`${chatId}-1`)] })
    })
    // Alice in the foreground with a split; Bob open in the background with
    // the same chat ids.
    const store = createAppStore(accountRef('alice'))
    const bob = openAccount(store, accountRef('bob'), { foreground: false })
    store.set({ me: ME, focus: A, split: { focus: B, side: 'right' }, splitShown: true })
    handle = startPoller({
      getClient: () => testClient({ account: accountRef('bob') }),
      store: bob,
      intervals: { activeMs: 30, listMs: 99_999, presenceMs: 99_999 },
    })
    await Bun.sleep(200)
    expect(calls).toEqual([])
    expect(bob.get().split).toBeNull()
  })
})

describe('split panes: read state and notifications', () => {
  test('a shown passive chat is marked read on poll; a hidden one keeps its unread', async () => {
    primeAuth()
    installChats((chatId) => Response.json({ value: [message(`${chatId}-1`)] }))
    const unread = { design: { unreadCount: 2, mentionCount: 0 } }
    const { store } = start(A, { focus: B, side: 'right' })
    store.set({ unreadByChatId: unread })
    await waitFor(() => !!store.get().messagesByConvo['chat:design'])
    await Bun.sleep(50)
    expect(store.get().unreadByChatId.design?.unreadCount).toBe(2)
    // It comes on screen: that side wakes, polls and marks it read.
    store.set({ splitShown: true })
    await waitFor(() => store.get().unreadByChatId.design?.unreadCount === 0)
  })

  test('a mention in a hidden passive chat counts; in a shown one it does not', async () => {
    primeAuth()
    let batch = [message('d1')]
    installChats(() => Response.json({ value: batch }))
    const events: MentionEvent[] = []
    const { store } = start(
      A,
      { focus: B, side: 'right' },
      { activeMs: 30, onMention: (e) => events.push(e) },
    )
    await waitFor(() => !!store.get().messagesByConvo['chat:design'])
    batch = [message('d1'), message('d2', { mentions: mentionsMe })]
    await waitFor(() => events.some((e) => e.message.id === 'd2'))
    await waitFor(() => store.get().unreadByChatId.design?.mentionCount === 1)
    // Shown: the next poll reads it.
    store.set({ splitShown: true })
    await waitFor(() => store.get().unreadByChatId.design?.mentionCount === 0)
    batch = [...batch, message('d3', { mentions: mentionsMe })]
    await waitFor(() => events.some((e) => e.message.id === 'd3'))
    await Bun.sleep(60)
    expect(store.get().unreadByChatId.design?.mentionCount).toBe(0)
  })

  test('cross-chat pass: a shown passive chat is read and silent; hidden, unread', async () => {
    primeAuth()
    let preview = 'p1'
    chatsList = () => [
      {
        id: 'design',
        chatType: 'group',
        createdDateTime: '2026-04-29T08:00:00Z',
        lastMessagePreview: {
          id: preview,
          createdDateTime: '2026-04-29T09:00:00Z',
          body: { contentType: 'text', content: 'hi' },
          from: { user: { id: 'u-alice', displayName: 'Alice Nordmann' } },
        },
      } as Chat,
    ]
    installChats(() => Response.json({ value: [message(preview, { mentions: mentionsMe })] }))
    const events: MentionEvent[] = []
    const { store } = start(
      A,
      { focus: B, side: 'right' },
      {
        listMs: 30,
        onMention: (e) => events.push(e),
      },
    )
    store.set({ splitShown: true })
    await waitFor(() => store.get().unreadByChatId.design !== undefined)
    preview = 'p2'
    await waitFor(() => store.get().unreadByChatId.design?.lastSeenPreviewId === 'p2')
    expect(store.get().unreadByChatId.design?.unreadCount).toBe(0)
    expect(events.filter((e) => e.source === 'list-diff')).toHaveLength(0)
    // Hidden (narrow terminal): the next preview change counts as unread.
    store.set({ splitShown: false })
    preview = 'p3'
    await waitFor(() => (store.get().unreadByChatId.design?.unreadCount ?? 0) > 0)
  })

  test('a channel and its thread side by side: one new reply notifies once', async () => {
    primeAuth()
    installChats(() => Response.json({ value: [] }))
    const root = message('root')
    let replies: ChatMessage[] = [message('r1', { replyToId: 'root' })]
    channelPage = async (focus) => ({
      messages: focus.kind === 'thread' ? [root, ...replies] : [root, ...replies],
    })
    const channel: Focus = { kind: 'channel', teamId: 't1', channelId: 'c1' }
    const thread: Focus = { kind: 'thread', teamId: 't1', channelId: 'c1', rootId: 'root' }
    const events: MentionEvent[] = []
    const { store } = start(
      channel,
      { focus: thread, side: 'right' },
      {
        activeMs: 30,
        onMention: (e) => events.push(e),
      },
    )
    await waitFor(() => !!store.get().messagesByConvo['thread:t1:c1:root'])
    await waitFor(() => !!store.get().messagesByConvo['channel:t1:c1'])
    await Bun.sleep(80)
    replies = [...replies, message('r2', { replyToId: 'root', mentions: mentionsMe })]
    await waitFor(() => events.length > 0)
    await Bun.sleep(200)
    expect(events.map((e) => e.message.id)).toEqual(['r2'])
  })

  test('a channel opened beside its thread seeds a new mention first: the thread still notifies', async () => {
    primeAuth()
    installChats(() => Response.json({ value: [] }))
    const root = message('root')
    let replies: ChatMessage[] = [message('r1', { replyToId: 'root' })]
    let gate: Promise<void> | null = null
    channelPage = async (focus) => {
      if (focus.kind === 'thread' && gate) await gate
      return { messages: [root, ...replies] }
    }
    const channel: Focus = { kind: 'channel', teamId: 't1', channelId: 'c1' }
    const thread: Focus = { kind: 'thread', teamId: 't1', channelId: 'c1', rootId: 'root' }
    const events: MentionEvent[] = []
    const { store } = start(thread, null, { activeMs: 30, onMention: (e) => events.push(e) })
    await waitFor(() => !!store.get().messagesByConvo['thread:t1:c1:root'])
    await Bun.sleep(80)
    // The mention arrives; the thread's fetches are held so the channel's
    // first fetch (which only seeds) sees it first.
    let release!: () => void
    gate = new Promise<void>((r) => (release = r))
    replies = [...replies, message('r2', { replyToId: 'root', mentions: mentionsMe })]
    store.set({ split: { focus: channel, side: 'right' }, splitShown: true })
    await waitFor(() => !!store.get().messagesByConvo['channel:t1:c1'])
    gate = null
    release()
    await waitFor(() => events.length > 0)
    await Bun.sleep(200)
    expect(events.map((e) => e.message.id)).toEqual(['r2'])
  })

  test('load older on the active thread lands in that thread after a pane switch', async () => {
    primeAuth()
    installChats((chatId) => Response.json({ value: [message(`${chatId}-1`)] }))
    let releaseOlder!: () => void
    const older = new Promise<void>((r) => (releaseOlder = r))
    const thread: Focus = { kind: 'thread', teamId: 't1', channelId: 'c1', rootId: 'root' }
    channelPage = async () => ({ messages: [message('root')], nextLink: 'https://chatsvc/next' })
    channelNext = async () => {
      await older
      return { messages: [message('old-1'), message('old-2')] }
    }
    const { store } = start(thread, { focus: A, side: 'right' })
    await waitFor(() => !!store.get().messagesByConvo['chat:chat-a'])
    await waitFor(() => !!store.get().messageCacheByConvo['thread:t1:c1:root']?.nextLink)
    const loading = handle!.loadOlderMessages(store.get().focus)
    store.set((s) => switchPane(s))
    expect(store.get().focus).toEqual(A)
    releaseOlder()
    const result = await loading
    expect(result.conv).toBe('thread:t1:c1:root')
    const ids = store.get().messageCacheByConvo['thread:t1:c1:root']!.messages.map((m) => m.id)
    expect([...ids].sort()).toEqual(['old-1', 'old-2', 'root'])
    expect(store.get().messagesByConvo['chat:chat-a']?.map((m) => m.id)).toEqual(['chat-a-1'])
    expect(store.get().messageCacheByConvo['chat:chat-a']?.loadingOlder ?? false).toBe(false)
  })
})
