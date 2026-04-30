import { afterEach, describe, expect, test } from 'bun:test'
import {
  __resetForTests as resetAuth,
  __setRunnerForTests as setAuthRunner,
} from '../auth/owaPiggy'
import { __resetForTests, __setTransportForTests } from '../graph/client'
import type { Capabilities } from '../graph/capabilities'
import type { Chat, ChatMessage, Mention } from '../types'
import { createAppStore, focusKey } from './store'
import {
  mergeChatMembers,
  mergeWithOptimistic,
  type MentionEvent,
  type PollerHandle,
  startPoller,
} from './poller'

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
  getChat: (chatId: string, init: RequestInit) => Response
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
    getChat: (chatId) =>
      jsonResponse({ id: chatId, chatType: 'oneOnOne', createdDateTime: '2026-04-29T08:00:00Z' }),
    ...overrides,
  }
}

function installTransport(handlers: MutableHandlers): void {
  __setTransportForTests(async (url, init) => {
    if (url.includes('/v1.0/https://')) {
      throw new Error(`nextLink was not normalized before graph(): ${url}`)
    }
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
    // GET /chats/{id} (with or without query string) - distinct from /messages
    // and from the bulk /chats? listing.
    const getChatMatch = url.match(/\/v1\.0\/chats\/([^/?]+)(?:\?|$)/)
    if (getChatMatch) return handlers.getChat(decodeURIComponent(getChatMatch[1]!), init)
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
    await waitFor(
      () =>
        focusKey(store.get().focus) !== null && Object.keys(store.get().messagesByConvo).length > 0,
    )
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

  test('merges newest page without discarding older cached or optimistic messages', async () => {
    primeAuth()
    const older: ChatMessage = {
      id: 'm-old',
      createdDateTime: '2026-04-29T08:00:00Z',
      body: { contentType: 'text', content: 'old' },
    }
    const optimistic: ChatMessage = {
      id: 'temp-1',
      _tempId: 'temp-1',
      _sending: true,
      createdDateTime: '2026-04-29T10:00:00Z',
      body: { contentType: 'text', content: 'sending' },
    }
    const newest: ChatMessage = {
      id: 'm-new',
      createdDateTime: '2026-04-29T09:00:00Z',
      body: { contentType: 'text', content: 'new' },
    }
    installTransport(
      makeHandlers({
        chatMessages: () =>
          jsonResponse({
            value: [newest],
            '@odata.nextLink':
              'https://graph.microsoft.com/v1.0/chats/c1/messages?$skiptoken=older',
          }),
      }),
    )
    const store = createAppStore()
    store.set({
      me: ME,
      focus: { kind: 'chat', chatId: 'c1' },
      messagesByConvo: { 'chat:c1': [older, optimistic] },
    })

    activeHandle = startPoller({
      store,
      intervals: { activeMs: 99_999, listMs: 99_999, presenceMs: 99_999 },
    })
    await waitFor(
      () => store.get().messagesByConvo['chat:c1']?.some((m) => m.id === 'm-new') === true,
    )
    expect(store.get().messagesByConvo['chat:c1']?.map((m) => m.id)).toEqual([
      'm-old',
      'm-new',
      'temp-1',
    ])
    expect(store.get().messageCacheByConvo['chat:c1']?.nextLink).toContain('$skiptoken=older')
    expect(store.get().messageCacheByConvo['chat:c1']?.fullyLoaded).toBe(false)
  })

  test('loadOlderMessages prepends older pages with dedupe and fullyLoaded metadata', async () => {
    primeAuth()
    let calls = 0
    installTransport(
      makeHandlers({
        chatMessages: () => {
          calls++
          if (calls === 1) {
            return jsonResponse({
              value: [
                {
                  id: 'm-new',
                  createdDateTime: '2026-04-29T10:00:00Z',
                  body: { contentType: 'text', content: 'new' },
                },
                {
                  id: 'm-mid',
                  createdDateTime: '2026-04-29T09:00:00Z',
                  body: { contentType: 'text', content: 'mid' },
                },
              ],
              '@odata.nextLink':
                'https://graph.microsoft.com/v1.0/chats/c1/messages?$skiptoken=older',
            })
          }
          return jsonResponse({
            value: [
              {
                id: 'm-mid',
                createdDateTime: '2026-04-29T09:00:00Z',
                body: { contentType: 'text', content: 'mid duplicate' },
              },
              {
                id: 'm-old',
                createdDateTime: '2026-04-29T08:00:00Z',
                body: { contentType: 'text', content: 'old' },
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
      intervals: { activeMs: 99_999, listMs: 99_999, presenceMs: 99_999 },
    })
    await waitFor(() => store.get().messageCacheByConvo['chat:c1']?.nextLink !== undefined)

    const result = await activeHandle.loadOlderMessages()

    expect(result).toMatchObject({ conv: 'chat:c1', added: 1, fullyLoaded: true })
    expect(result.anchorMessageId).toBe('m-mid')
    expect(store.get().messagesByConvo['chat:c1']?.map((m) => m.id)).toEqual([
      'm-old',
      'm-mid',
      'm-new',
    ])
    const cache = store.get().messageCacheByConvo['chat:c1']
    expect(cache?.loadingOlder).toBe(false)
    expect(cache?.fullyLoaded).toBe(true)
    expect(cache?.lastOlderLoad).toEqual({ beforeFirstId: 'm-mid', addedCount: 1 })
  })

  test('loadOlderMessages stores errors and clears loadingOlder on failure', async () => {
    primeAuth()
    let calls = 0
    installTransport(
      makeHandlers({
        chatMessages: () => {
          calls++
          if (calls === 1) {
            return jsonResponse({
              value: [
                {
                  id: 'm-new',
                  createdDateTime: '2026-04-29T10:00:00Z',
                  body: { contentType: 'text', content: 'new' },
                },
              ],
              '@odata.nextLink':
                'https://graph.microsoft.com/v1.0/chats/c1/messages?$skiptoken=older',
            })
          }
          return new Response('bad gateway', { status: 502 })
        },
      }),
    )
    const store = createAppStore()
    store.set({ me: ME, focus: { kind: 'chat', chatId: 'c1' } })
    activeHandle = startPoller({
      store,
      intervals: { activeMs: 99_999, listMs: 99_999, presenceMs: 99_999 },
    })
    await waitFor(() => store.get().messageCacheByConvo['chat:c1']?.nextLink !== undefined)

    const result = await activeHandle.loadOlderMessages()

    expect(result.error?.message).toContain('Graph 502')
    const cache = store.get().messageCacheByConvo['chat:c1']
    expect(cache?.loadingOlder).toBe(false)
    expect(cache?.error).toContain('Graph 502')
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

  test('sets lastListPollAt on a successful list poll', async () => {
    primeAuth()
    installTransport(
      makeHandlers({
        '/chats': () =>
          jsonResponse({
            value: [{ id: 'c1', chatType: 'oneOnOne', createdDateTime: '2026-04-29T08:00:00Z' }],
          }),
      }),
    )
    const store = createAppStore()
    activeHandle = startPoller({
      store,
      intervals: { activeMs: 99_999, listMs: 30, presenceMs: 99_999 },
    })
    await waitFor(() => store.get().lastListPollAt !== undefined)
    const t = store.get().lastListPollAt!
    expect(t instanceof Date).toBe(true)
    expect(Date.now() - t.getTime()).toBeLessThan(2_000)
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

  test('seeds unread activity on first list poll without counting unread', async () => {
    primeAuth()
    installTransport(
      makeHandlers({
        '/chats': () =>
          jsonResponse({
            value: [
              {
                id: 'c1',
                chatType: 'group',
                createdDateTime: '2026-04-29T08:00:00Z',
                lastMessagePreview: {
                  id: 'p1',
                  createdDateTime: '2026-04-29T09:00:00Z',
                  body: { contentType: 'text', content: 'seed' },
                  from: { user: { id: 'other', displayName: 'Other' } },
                },
              },
            ],
          }),
      }),
    )
    const store = createAppStore()
    store.set({ me: ME })
    activeHandle = startPoller({
      store,
      intervals: { activeMs: 99_999, listMs: 30, presenceMs: 99_999 },
    })
    await waitFor(() => store.get().unreadByChatId.c1 !== undefined)
    expect(store.get().unreadByChatId.c1?.lastSeenPreviewId).toBe('p1')
    expect(store.get().unreadByChatId.c1?.unreadCount).toBe(0)
    expect(store.get().unreadByChatId.c1?.mentionCount).toBe(0)
  })

  test('counts later non-self preview changes as unread and suppresses self messages', async () => {
    primeAuth()
    let phase: 'seed' | 'other' | 'self' = 'seed'
    installTransport(
      makeHandlers({
        '/chats': () => {
          const id = phase === 'seed' ? 'p1' : phase === 'other' ? 'p2' : 'p3'
          const senderId = phase === 'self' ? ME.id : 'other'
          return jsonResponse({
            value: [
              {
                id: 'c1',
                chatType: 'group',
                createdDateTime: '2026-04-29T08:00:00Z',
                lastMessagePreview: {
                  id,
                  createdDateTime: '2026-04-29T09:00:00Z',
                  body: { contentType: 'text', content: id },
                  from: { user: { id: senderId, displayName: senderId } },
                },
              },
            ],
          })
        },
      }),
    )
    const store = createAppStore()
    store.set({ me: ME })
    activeHandle = startPoller({
      store,
      intervals: { activeMs: 99_999, listMs: 30, presenceMs: 99_999 },
    })
    await waitFor(() => store.get().unreadByChatId.c1 !== undefined)
    phase = 'other'
    await waitFor(() => store.get().unreadByChatId.c1?.unreadCount === 1)
    phase = 'self'
    await waitFor(() => store.get().unreadByChatId.c1?.unreadCount === 0)
    expect(store.get().unreadByChatId.c1?.lastSeenPreviewId).toBe('p3')
  })

  test('active chat preview changes clear unread activity', async () => {
    primeAuth()
    let phase: 'seed' | 'after' = 'seed'
    installTransport(
      makeHandlers({
        '/chats': () =>
          jsonResponse({
            value: [
              {
                id: 'active-chat',
                chatType: 'group',
                createdDateTime: '2026-04-29T08:00:00Z',
                lastMessagePreview: {
                  id: phase === 'seed' ? 'p1' : 'p2',
                  createdDateTime: '2026-04-29T09:00:00Z',
                  body: { contentType: 'text', content: 'hi' },
                  from: { user: { id: 'other', displayName: 'Other' } },
                },
              },
            ],
          }),
      }),
    )
    const store = createAppStore()
    store.set({ me: ME, focus: { kind: 'chat', chatId: 'active-chat' } })
    activeHandle = startPoller({
      store,
      intervals: { activeMs: 99_999, listMs: 30, presenceMs: 99_999 },
    })
    await waitFor(() => store.get().unreadByChatId['active-chat'] !== undefined)
    phase = 'after'
    await waitFor(() => store.get().unreadByChatId['active-chat']?.lastSeenPreviewId === 'p2')
    expect(store.get().unreadByChatId['active-chat']?.unreadCount).toBe(0)
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

describe('cross-chat mention detection', () => {
  type Phase = 'before' | 'after'
  let phase: Phase = 'before'

  function setupChatList(): { chatId: string; previewBefore: string; previewAfter: string } {
    const chatId = 'chat-x'
    const previewBefore = 'preview-before'
    const previewAfter = 'preview-after'

    installTransport(
      makeHandlers({
        '/chats': () =>
          jsonResponse({
            value: [
              {
                id: chatId,
                chatType: 'group',
                createdDateTime: '2026-04-29T08:00:00Z',
                lastMessagePreview:
                  phase === 'before'
                    ? {
                        id: previewBefore,
                        createdDateTime: '2026-04-29T08:00:00Z',
                        body: { contentType: 'text', content: 'previous' },
                        from: { user: { id: 'other-1', displayName: 'Other' } },
                      }
                    : {
                        id: previewAfter,
                        createdDateTime: '2026-04-29T09:00:00Z',
                        body: { contentType: 'text', content: '@me hi' },
                        from: { user: { id: 'other-1', displayName: 'Other' } },
                      },
              },
            ],
          }),
        chatMessages: () =>
          jsonResponse({
            value: [
              {
                id: previewAfter,
                createdDateTime: '2026-04-29T09:00:00Z',
                body: { contentType: 'text', content: '@me hi' },
                from: { user: { id: 'other-1', displayName: 'Other' } },
                mentions: mentionedMe(ME.id),
              },
            ],
          }),
      }),
    )
    return { chatId, previewBefore, previewAfter }
  }

  test('fires list-diff mention for non-active chat with @ to me from non-self', async () => {
    primeAuth()
    phase = 'before'
    setupChatList()
    const store = createAppStore()
    store.set({ me: ME, focus: { kind: 'list' } })
    const events: MentionEvent[] = []
    activeHandle = startPoller({
      store,
      intervals: { activeMs: 99_999, listMs: 30, presenceMs: 99_999 },
      onMention: (e) => events.push(e),
    })
    await waitFor(() => store.get().chats.length > 0)
    // First list poll seeded prevPreviewIds; no notification yet.
    expect(events).toHaveLength(0)
    phase = 'after'
    await waitFor(() => events.length > 0)
    expect(events[0]?.source).toBe('list-diff')
    expect(events[0]?.conv).toBe('chat:chat-x')
    expect(events[0]?.message.id).toBe('preview-after')
    expect(store.get().unreadByChatId['chat-x']?.mentionCount).toBe(1)
  })

  test('does not fire when the new preview is from self', async () => {
    primeAuth()
    let p: 'before' | 'after' = 'before'
    installTransport(
      makeHandlers({
        '/chats': () =>
          jsonResponse({
            value: [
              {
                id: 'c',
                chatType: 'group',
                createdDateTime: '2026-04-29T08:00:00Z',
                lastMessagePreview: {
                  id: p === 'before' ? 'preview-1' : 'preview-2',
                  createdDateTime: p === 'before' ? '2026-04-29T08:00:00Z' : '2026-04-29T09:00:00Z',
                  body: { contentType: 'text', content: 'hi' },
                  from: { user: { id: ME.id, displayName: 'Me' } },
                },
              },
            ],
          }),
        chatMessages: () => {
          throw new Error('chat messages should not be probed when sender is self')
        },
      }),
    )
    const store = createAppStore()
    store.set({ me: ME, focus: { kind: 'list' } })
    const events: MentionEvent[] = []
    activeHandle = startPoller({
      store,
      intervals: { activeMs: 99_999, listMs: 30, presenceMs: 99_999 },
      onMention: (e) => events.push(e),
    })
    await waitFor(() => store.get().chats.length > 0)
    p = 'after'
    await Bun.sleep(180)
    expect(events).toHaveLength(0)
  })

  test('does not fire when the chat is the currently active focus', async () => {
    primeAuth()
    let p: 'before' | 'after' = 'before'
    installTransport(
      makeHandlers({
        '/chats': () =>
          jsonResponse({
            value: [
              {
                id: 'active-chat',
                chatType: 'group',
                createdDateTime: '2026-04-29T08:00:00Z',
                lastMessagePreview: {
                  id: p === 'before' ? 'preview-1' : 'preview-2',
                  createdDateTime: p === 'before' ? '2026-04-29T08:00:00Z' : '2026-04-29T09:00:00Z',
                  body: { contentType: 'text', content: 'hi' },
                  from: { user: { id: 'other', displayName: 'Other' } },
                },
              },
            ],
          }),
        chatMessages: () =>
          jsonResponse({
            value: [
              {
                id: 'preview-2',
                createdDateTime: '2026-04-29T09:00:00Z',
                body: { contentType: 'text', content: '@me hi' },
                from: { user: { id: 'other', displayName: 'Other' } },
                mentions: mentionedMe(ME.id),
              },
            ],
          }),
      }),
    )
    const store = createAppStore()
    store.set({ me: ME, focus: { kind: 'chat', chatId: 'active-chat' } })
    const events: MentionEvent[] = []
    activeHandle = startPoller({
      store,
      intervals: { activeMs: 99_999, listMs: 30, presenceMs: 99_999 },
      onMention: (e) => events.push(e),
    })
    await waitFor(() => store.get().chats.length > 0)
    p = 'after'
    await Bun.sleep(180)
    // The list-diff scan must skip the active chat - any mention there
    // is the active loop's responsibility.
    expect(events.some((e) => e.source === 'list-diff')).toBe(false)
  })
})

describe('member hydration', () => {
  test('hydrates members for chats lacking them after a list poll', async () => {
    primeAuth()
    const chat: Chat = {
      id: 'c1',
      chatType: 'oneOnOne',
      createdDateTime: '2026-04-29T08:00:00Z',
    }
    installTransport(
      makeHandlers({
        '/chats': () => jsonResponse({ value: [chat] }),
        getChat: (chatId) =>
          jsonResponse({
            id: chatId,
            chatType: 'oneOnOne',
            createdDateTime: '2026-04-29T08:00:00Z',
            members: [
              { id: 'mem-me', userId: 'me-id', displayName: 'Me' },
              { id: 'mem-iver', userId: 'iver-id', displayName: 'Daljord, Iver' },
            ],
          }),
      }),
    )
    const store = createAppStore()
    store.set({ me: ME })
    activeHandle = startPoller({
      store,
      intervals: { activeMs: 99_999, listMs: 30, presenceMs: 99_999 },
    })
    await waitFor(() => (store.get().chats[0]?.members?.length ?? 0) > 0)
    const c = store.get().chats[0]!
    expect(c.members?.find((m) => m.userId === 'iver-id')?.displayName).toBe('Daljord, Iver')
  })

  test('preserves hydrated members across subsequent list polls', async () => {
    primeAuth()
    const chat: Chat = {
      id: 'c1',
      chatType: 'oneOnOne',
      createdDateTime: '2026-04-29T08:00:00Z',
    }
    let getChatCalls = 0
    installTransport(
      makeHandlers({
        '/chats': () => jsonResponse({ value: [chat] }),
        getChat: (chatId) => {
          getChatCalls++
          return jsonResponse({
            id: chatId,
            chatType: 'oneOnOne',
            createdDateTime: '2026-04-29T08:00:00Z',
            members: [
              { id: 'mem-me', userId: 'me-id', displayName: 'Me' },
              { id: 'mem-other', userId: 'other-id', displayName: 'Other Person' },
            ],
          })
        },
      }),
    )
    const store = createAppStore()
    store.set({ me: ME })
    activeHandle = startPoller({
      store,
      intervals: { activeMs: 99_999, listMs: 30, presenceMs: 99_999 },
    })
    await waitFor(() => (store.get().chats[0]?.members?.length ?? 0) > 0)
    const callsAfterFirstHydrate = getChatCalls
    // Wait long enough for several more list-poll iterations.
    await Bun.sleep(180)
    const c = store.get().chats[0]!
    // Members must still be hydrated even though the list poll has run
    // again - mergeChatMembers carries them forward.
    expect(c.members?.find((m) => m.userId === 'other-id')?.displayName).toBe('Other Person')
    // And subsequent polls should not re-issue getChat for already-hydrated chats.
    expect(getChatCalls).toBe(callsAfterFirstHydrate)
  })

  test('skips hydration for chats whose label comes from topic', async () => {
    primeAuth()
    const chat: Chat = {
      id: 'group-1',
      chatType: 'group',
      topic: 'NOCOS/IAM/HELPDESK',
      createdDateTime: '2026-04-29T08:00:00Z',
    }
    let getChatCalls = 0
    installTransport(
      makeHandlers({
        '/chats': () => jsonResponse({ value: [chat] }),
        getChat: (chatId) => {
          getChatCalls++
          return jsonResponse({
            id: chatId,
            chatType: 'group',
            topic: 'NOCOS/IAM/HELPDESK',
            createdDateTime: '2026-04-29T08:00:00Z',
            members: [],
          })
        },
      }),
    )
    const store = createAppStore()
    store.set({ me: ME })
    activeHandle = startPoller({
      store,
      intervals: { activeMs: 99_999, listMs: 30, presenceMs: 99_999 },
    })
    await waitFor(() => store.get().chats.length > 0)
    await Bun.sleep(120)
    expect(getChatCalls).toBe(0)
  })
})

describe('mergeChatMembers', () => {
  const c = (id: string, members?: Chat['members']): Chat => ({
    id,
    chatType: 'oneOnOne',
    createdDateTime: '2026-04-29T08:00:00Z',
    members,
  })

  test('returns next as-is when prev is empty', () => {
    const next = [c('a'), c('b')]
    expect(mergeChatMembers([], next)).toBe(next)
  })

  test('carries forward members from prev when next has none', () => {
    const prev = [c('a', [{ id: 'm1', userId: 'u1', displayName: 'Alice' }])]
    const next = [c('a')]
    const merged = mergeChatMembers(prev, next)
    expect(merged[0]?.members?.[0]?.displayName).toBe('Alice')
  })

  test('prefers next.members when both have them', () => {
    const prev = [c('a', [{ id: 'm1', userId: 'u1', displayName: 'old' }])]
    const next = [c('a', [{ id: 'm2', userId: 'u2', displayName: 'new' }])]
    const merged = mergeChatMembers(prev, next)
    expect(merged[0]?.members?.[0]?.displayName).toBe('new')
  })

  test('passes through chats not in prev', () => {
    const prev = [c('a', [{ id: 'm1', userId: 'u1', displayName: 'Alice' }])]
    const next = [c('b')]
    const merged = mergeChatMembers(prev, next)
    expect(merged[0]?.id).toBe('b')
    expect(merged[0]?.members).toBeUndefined()
  })
})

describe('mergeWithOptimistic', () => {
  const m = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
    id,
    createdDateTime: '2026-04-29T09:00:00Z',
    body: { contentType: 'text', content: id },
    ...extra,
  })

  test('returns the server list verbatim when there are no optimistic msgs', () => {
    const merged = mergeWithOptimistic([m('a'), m('b')], [m('a'), m('b'), m('c')])
    expect(merged.map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })

  test('preserves still-sending optimistic messages at the end', () => {
    const opt = m('temp-1', { _tempId: 'temp-1', _sending: true })
    const merged = mergeWithOptimistic([m('a'), opt], [m('a')])
    expect(merged.map((x) => x.id)).toEqual(['a', 'temp-1'])
    expect(merged[1]?._sending).toBe(true)
  })

  test('preserves _sendError messages that have no server-id match', () => {
    const failed = m('temp-2', { _tempId: 'temp-2', _sendError: 'forbidden' })
    const merged = mergeWithOptimistic([m('a'), failed], [m('a')])
    expect(merged.map((x) => x.id)).toEqual(['a', 'temp-2'])
    expect(merged[1]?._sendError).toBe('forbidden')
  })

  test('drops _sendError messages whose ids now exist in the server list', () => {
    // Edge case: after the user retries, the failed clone may have been
    // replaced by a server-confirmed message with the same id. Drop the
    // local error entry to avoid showing duplicates.
    const failed = m('server-x', { _sendError: 'forbidden' })
    const merged = mergeWithOptimistic([failed], [m('server-x')])
    expect(merged.map((x) => x.id)).toEqual(['server-x'])
    expect(merged[0]?._sendError).toBeUndefined()
  })

  test('does not duplicate when an optimistic message becomes server-confirmed', () => {
    // After Composer replaces optimistic with the server response, the
    // _sending flag is gone. The next poller fetch returns that server msg
    // - merge should not carry anything extra.
    const confirmed = m('server-1') // no _sending flag
    const merged = mergeWithOptimistic([m('a'), confirmed], [m('a'), m('server-1')])
    expect(merged.map((x) => x.id)).toEqual(['a', 'server-1'])
  })
})
