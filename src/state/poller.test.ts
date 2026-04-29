import { afterEach, describe, expect, test } from 'bun:test'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'
import { __resetForTests, __setTransportForTests } from '../graph/client'
import type { Capabilities } from '../graph/capabilities'
import type { Chat, ChatMessage, Mention } from '../types'
import { createAppStore, focusKey } from './store'
import { type MentionEvent, type PollerHandle, startPoller } from './poller'

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json' },
  })
}

function primeAuth(): void {
  setAuthRunner(async () => ({
    stdout: makeJwt({ exp: FAR_FUTURE }),
    stderr: '',
    exitCode: 0,
  }))
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error('waitFor timed out')
}

type MutableHandlers = {
  '/me/presence': (init: RequestInit) => Response
  '/chats': (init: RequestInit) => Response
  '/me/joinedTeams': (init: RequestInit) => Response
  channelMessages: (init: RequestInit) => Response
  chatMessages: (chatId: string, init: RequestInit) => Response
  channels: (teamId: string, init: RequestInit) => Response
}

function makeHandlers(overrides?: Partial<MutableHandlers>): MutableHandlers {
  return {
    '/me/presence': () =>
      jsonResponse({ id: 'me-id', availability: 'Available', activity: 'Available' }),
    '/chats': () => jsonResponse({ value: [] }),
    '/me/joinedTeams': () => jsonResponse({ value: [] }),
    channelMessages: () => jsonResponse({ value: [] }),
    chatMessages: () => jsonResponse({ value: [] }),
    channels: () => jsonResponse({ value: [] }),
    ...overrides,
  }
}

function installTransport(handlers: MutableHandlers): void {
  __setTransportForTests(async (url, init) => {
    if (url.endsWith('/v1.0/me/presence')) return handlers['/me/presence'](init)
    if (url.includes('/v1.0/chats?')) return handlers['/chats'](init)
    if (url === 'https://graph.microsoft.com/v1.0/me/joinedTeams') {
      return handlers['/me/joinedTeams'](init)
    }
    const chatMessagesMatch = url.match(/\/v1\.0\/chats\/([^/]+)\/messages/)
    if (chatMessagesMatch) {
      return handlers.chatMessages(decodeURIComponent(chatMessagesMatch[1]!), init)
    }
    const channelMessagesMatch = url.match(/\/v1\.0\/teams\/[^/]+\/channels\/[^/]+\/messages/)
    if (channelMessagesMatch) return handlers.channelMessages(init)
    const channelsMatch = url.match(/\/v1\.0\/teams\/([^/]+)\/channels/)
    if (channelsMatch) return handlers.channels(decodeURIComponent(channelsMatch[1]!), init)
    throw new Error(`unhandled URL in poller test transport: ${url}`)
  })
}

const ME = {
  id: 'me-id',
  displayName: 'Me',
  userPrincipalName: 'me@example.com',
  mail: null,
}

function mentionedMe(myId: string): Mention[] {
  return [{ id: 0, mentionText: '@Me', mentioned: { user: { id: myId, displayName: 'Me' } } }]
}

let activeHandle: PollerHandle | null = null

afterEach(async () => {
  if (activeHandle) {
    await activeHandle.stop()
    activeHandle = null
  }
  __resetForTests()
  resetAuth()
})

describe('active loop', () => {
  test('seeds the seen-set on first fetch and emits no notifications', async () => {
    primeAuth()
    const messages: ChatMessage[] = [
      {
        id: 'm-1',
        createdDateTime: '2026-04-29T09:00:00Z',
        body: { contentType: 'text', content: 'hi' },
        from: { user: { id: 'other-1', displayName: 'Other' } },
        mentions: mentionedMe(ME.id),
      },
    ]
    installTransport(
      makeHandlers({
        chatMessages: () => jsonResponse({ value: messages }),
      }),
    )
    const store = createAppStore()
    store.set({ me: ME, focus: { kind: 'chat', chatId: 'c1' } })

    const events: MentionEvent[] = []
    activeHandle = startPoller({
      store,
      intervals: { activeMs: 30, listMs: 99_999, presenceMs: 99_999 },
      onMention: (e) => events.push(e),
    })
    await waitFor(() => focusKey(store.get().focus) !== null && Object.keys(store.get().messagesByConvo).length > 0)
    expect(store.get().messagesByConvo['chat:c1']).toEqual(messages)
    // First fetch: seed only - no mention even though message mentions me.
    expect(events).toHaveLength(0)
  })

  test('notifies on a new mention from a non-self sender on a subsequent fetch', async () => {
    primeAuth()
    let returnNew = false
    const seed: ChatMessage[] = [
      {
        id: 'm-old',
        createdDateTime: '2026-04-29T09:00:00Z',
        body: { contentType: 'text', content: 'old' },
        from: { user: { id: 'other-1', displayName: 'Other' } },
      },
    ]
    const newMention: ChatMessage = {
      id: 'm-new',
      createdDateTime: '2026-04-29T09:01:00Z',
      body: { contentType: 'text', content: '@Me ping' },
      from: { user: { id: 'other-1', displayName: 'Other' } },
      mentions: mentionedMe(ME.id),
    }
    installTransport(
      makeHandlers({
        chatMessages: () => jsonResponse({ value: returnNew ? [...seed, newMention] : seed }),
      }),
    )
    const store = createAppStore()
    store.set({ me: ME, focus: { kind: 'chat', chatId: 'c1' } })

    const events: MentionEvent[] = []
    activeHandle = startPoller({
      store,
      intervals: { activeMs: 30, listMs: 99_999, presenceMs: 99_999 },
      onMention: (e) => events.push(e),
    })
    await waitFor(() => store.get().messagesByConvo['chat:c1']?.length === 1)
    returnNew = true
    await waitFor(() => events.length > 0)
    expect(events).toHaveLength(1)
    expect(events[0]?.message.id).toBe('m-new')
    expect(events[0]?.conv).toBe('chat:c1')
  })

  test('does not notify on own messages echoed back through the poll', async () => {
    primeAuth()
    let phase = 0
    installTransport(
      makeHandlers({
        chatMessages: () => {
          phase++
          if (phase === 1) return jsonResponse({ value: [] })
          // Subsequent fetches return a "self" message with a mention to me
          return jsonResponse({
            value: [
              {
                id: 'm-self',
                createdDateTime: '2026-04-29T09:00:00Z',
                body: { contentType: 'text', content: '@Me note to self' },
                from: { user: { id: ME.id, displayName: 'Me' } },
                mentions: mentionedMe(ME.id),
              },
            ],
          })
        },
      }),
    )
    const store = createAppStore()
    store.set({ me: ME, focus: { kind: 'chat', chatId: 'c1' } })

    const events: MentionEvent[] = []
    activeHandle = startPoller({
      store,
      intervals: { activeMs: 30, listMs: 99_999, presenceMs: 99_999 },
      onMention: (e) => events.push(e),
    })
    // Wait long enough for the seed + at least one diff iteration
    await Bun.sleep(180)
    expect(events).toHaveLength(0)
  })

  test('focus change interrupts active sleep and starts polling the new conv', async () => {
    primeAuth()
    const seenChats: string[] = []
    installTransport(
      makeHandlers({
        chatMessages: (chatId) => {
          seenChats.push(chatId)
          return jsonResponse({
            value: [
              {
                id: `${chatId}-m1`,
                createdDateTime: '2026-04-29T09:00:00Z',
                body: { contentType: 'text', content: chatId },
              },
            ],
          })
        },
      }),
    )
    const store = createAppStore()
    store.set({ me: ME, focus: { kind: 'chat', chatId: 'c1' } })

    activeHandle = startPoller({
      store,
      intervals: { activeMs: 9_999, listMs: 99_999, presenceMs: 99_999 },
      onMention: () => {},
    })
    await waitFor(() => store.get().messagesByConvo['chat:c1'] !== undefined)
    store.set({ focus: { kind: 'chat', chatId: 'c2' } })
    await waitFor(() => store.get().messagesByConvo['chat:c2'] !== undefined)
    expect(seenChats).toContain('c1')
    expect(seenChats).toContain('c2')
  })

  test('list focus skips the active fetch entirely', async () => {
    primeAuth()
    let chatMessageCalls = 0
    installTransport(
      makeHandlers({
        chatMessages: () => {
          chatMessageCalls++
          return jsonResponse({ value: [] })
        },
      }),
    )
    const store = createAppStore()
    store.set({ me: ME, focus: { kind: 'list' } })
    activeHandle = startPoller({
      store,
      intervals: { activeMs: 20, listMs: 99_999, presenceMs: 99_999 },
    })
    await Bun.sleep(150)
    expect(chatMessageCalls).toBe(0)
  })
})

describe('list loop', () => {
  test('populates chats from /chats', async () => {
    primeAuth()
    const chat: Chat = {
      id: 'chat-1',
      chatType: 'oneOnOne',
      createdDateTime: '2026-04-29T08:00:00Z',
    }
    installTransport(
      makeHandlers({
        '/chats': () => jsonResponse({ value: [chat] }),
      }),
    )
    const store = createAppStore()
    activeHandle = startPoller({
      store,
      intervals: { activeMs: 99_999, listMs: 30, presenceMs: 99_999 },
    })
    await waitFor(() => store.get().chats.length > 0)
    expect(store.get().chats[0]?.id).toBe('chat-1')
    expect(store.get().conn).toBe('online')
  })

  test('marks conn=offline on a 5xx error', async () => {
    primeAuth()
    installTransport(
      makeHandlers({
        '/chats': () =>
          new Response('boom', { status: 503, headers: { 'content-type': 'text/plain' } }),
      }),
    )
    const errors: { loop: string; err: Error }[] = []
    const store = createAppStore()
    activeHandle = startPoller({
      store,
      intervals: { activeMs: 99_999, listMs: 30, presenceMs: 99_999 },
      onError: (loop, err) => errors.push({ loop, err }),
    })
    await waitFor(() => store.get().conn === 'offline')
    expect(errors.some((e) => e.loop === 'list')).toBe(true)
  })
})

describe('presence loop', () => {
  test('updates myPresence when capability is ok', async () => {
    primeAuth()
    installTransport(makeHandlers())
    const store = createAppStore()
    const caps: Capabilities = {
      me: { ok: true },
      chats: { ok: true },
      joinedTeams: { ok: true },
      presence: { ok: true },
    }
    store.set({ capabilities: caps })
    activeHandle = startPoller({
      store,
      intervals: { activeMs: 99_999, listMs: 99_999, presenceMs: 30 },
    })
    await waitFor(() => store.get().myPresence !== undefined)
    expect(store.get().myPresence?.availability).toBe('Available')
  })

  test('skips presence calls entirely when capability is unavailable', async () => {
    primeAuth()
    let presenceCalls = 0
    installTransport(
      makeHandlers({
        '/me/presence': () => {
          presenceCalls++
          return jsonResponse({
            id: 'x',
            availability: 'Available',
            activity: 'Available',
          })
        },
      }),
    )
    const store = createAppStore()
    const caps: Capabilities = {
      me: { ok: true },
      chats: { ok: true },
      joinedTeams: { ok: true },
      presence: { ok: false, reason: 'unavailable', status: 403, message: 'Forbidden' },
    }
    store.set({ capabilities: caps })
    activeHandle = startPoller({
      store,
      intervals: { activeMs: 99_999, listMs: 99_999, presenceMs: 30 },
    })
    await Bun.sleep(120)
    expect(presenceCalls).toBe(0)
    expect(store.get().myPresence).toBeUndefined()
  })
})

describe('stop', () => {
  test('stops further fetches after stop() resolves', async () => {
    primeAuth()
    let chatsCalls = 0
    installTransport(
      makeHandlers({
        '/chats': () => {
          chatsCalls++
          return jsonResponse({ value: [] })
        },
      }),
    )
    const store = createAppStore()
    const handle = startPoller({
      store,
      intervals: { activeMs: 99_999, listMs: 30, presenceMs: 99_999 },
    })
    await waitFor(() => chatsCalls >= 1)
    await handle.stop()
    const before = chatsCalls
    await Bun.sleep(120)
    expect(chatsCalls).toBe(before)
    activeHandle = null
  })
})
