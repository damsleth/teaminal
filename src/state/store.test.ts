import { describe, expect, test } from 'bun:test'
import {
  bumpChatMention,
  clampMessageCursor,
  createAppStore,
  emptyMessageCache,
  type Focus,
  focusKey,
  initialAppState,
  markChatRead,
  markChatUnread,
  messagesFromCaches,
  moveMessageCursor,
  recentUnreadNotifications,
  seedChatActivity,
  setMessageCursor,
  Store,
  unreadTotals,
} from './store'

describe('Store basics', () => {
  test('get() returns current state', () => {
    const s = new Store({ count: 0 })
    expect(s.get()).toEqual({ count: 0 })
  })

  test('set() merges a partial patch', () => {
    const s = new Store({ count: 0, name: 'x' })
    s.set({ count: 1 })
    expect(s.get()).toEqual({ count: 1, name: 'x' })
  })

  test('set() with an updater function gets current state', () => {
    const s = new Store({ count: 0 })
    s.set((cur) => ({ count: cur.count + 5 }))
    expect(s.get().count).toBe(5)
  })

  test('returns a new state object reference on change (immutability)', () => {
    const s = new Store({ count: 0 })
    const before = s.get()
    s.set({ count: 1 })
    const after = s.get()
    expect(after).not.toBe(before)
    expect(before.count).toBe(0) // before reference is unchanged
  })

  test('skips listeners when no field actually changes', () => {
    const s = new Store({ count: 0 })
    let calls = 0
    s.subscribe(() => {
      calls++
    })
    s.set({ count: 0 })
    expect(calls).toBe(0)
  })

  test('skips undefined fields in the patch (preserves existing value)', () => {
    const s = new Store<{ count: number; name?: string }>({ count: 0, name: 'x' })
    s.set({ name: undefined })
    expect(s.get().name).toBe('x')
  })

  test('fires listeners synchronously after change', () => {
    const s = new Store({ count: 0 })
    const seen: number[] = []
    s.subscribe((state) => seen.push(state.count))
    s.set({ count: 1 })
    s.set({ count: 2 })
    expect(seen).toEqual([1, 2])
  })

  test('multiple listeners all fire', () => {
    const s = new Store({ count: 0 })
    let a = 0
    let b = 0
    s.subscribe(() => {
      a++
    })
    s.subscribe(() => {
      b++
    })
    s.set({ count: 1 })
    expect(a).toBe(1)
    expect(b).toBe(1)
  })

  test('unsubscribe stops further notifications', () => {
    const s = new Store({ count: 0 })
    let calls = 0
    const off = s.subscribe(() => {
      calls++
    })
    s.set({ count: 1 })
    off()
    s.set({ count: 2 })
    expect(calls).toBe(1)
  })
})

describe('focusKey', () => {
  test('returns null for list focus', () => {
    expect(focusKey({ kind: 'list' })).toBeNull()
  })

  test('encodes chat focus with chat: prefix', () => {
    expect(focusKey({ kind: 'chat', chatId: '19:abc' })).toBe('chat:19:abc')
  })

  test('encodes channel focus with team and channel ids', () => {
    expect(focusKey({ kind: 'channel', teamId: 'team-1', channelId: '19:gen' })).toBe(
      'channel:team-1:19:gen',
    )
  })

  test('different focus shapes never collide', () => {
    const a = focusKey({ kind: 'chat', chatId: 'x' })
    const b = focusKey({ kind: 'channel', teamId: 'y', channelId: 'x' })
    const c = focusKey({ kind: 'channel', teamId: 'x', channelId: 'y' })
    expect(new Set([a, b, c]).size).toBe(3)
  })
})

describe('createAppStore', () => {
  test('returns a Store seeded with the initial AppState', () => {
    const s = createAppStore()
    expect(s.get()).toEqual(initialAppState())
    expect(s.get().focus).toEqual({ kind: 'list' })
    expect(s.get().chats).toEqual([])
    expect(s.get().conn).toBe('connecting')
    expect(s.get().realtimeState).toBe('off')
    expect(s.get().typingByConvo).toEqual({})
  })

  test('focus updates fire listeners', () => {
    const s = createAppStore()
    const focuses: Focus[] = []
    s.subscribe((state) => focuses.push(state.focus))
    s.set({ focus: { kind: 'chat', chatId: 'c1' } })
    s.set({ focus: { kind: 'channel', teamId: 't', channelId: 'c' } })
    s.set({ focus: { kind: 'list' } })
    expect(focuses).toEqual([
      { kind: 'chat', chatId: 'c1' },
      { kind: 'channel', teamId: 't', channelId: 'c' },
      { kind: 'list' },
    ])
  })
})

describe('message cache helpers', () => {
  test('emptyMessageCache seeds metadata around messages', () => {
    const cache = emptyMessageCache([
      {
        id: 'm1',
        createdDateTime: '2026-04-29T09:00:00Z',
        body: { contentType: 'text', content: 'hi' },
      },
    ])
    expect(cache.messages.map((m) => m.id)).toEqual(['m1'])
    expect(cache.loadingOlder).toBe(false)
    expect(cache.fullyLoaded).toBe(false)
  })

  test('messagesFromCaches keeps legacy array consumers readable', () => {
    const caches = {
      'chat:c1': emptyMessageCache([
        {
          id: 'm1',
          createdDateTime: '2026-04-29T09:00:00Z',
          body: { contentType: 'text', content: 'hi' },
        },
      ]),
    }
    expect(messagesFromCaches(caches)['chat:c1']?.[0]?.id).toBe('m1')
  })
})

describe('unread helpers', () => {
  const chat = {
    id: 'c1',
    chatType: 'group' as const,
    createdDateTime: '2026-04-29T08:00:00Z',
    lastMessagePreview: {
      id: 'p1',
      createdDateTime: '2026-04-29T09:00:00Z',
      body: { contentType: 'text' as const, content: 'hello' },
      from: { user: { id: 'u1', displayName: 'Other' } },
    },
  }

  test('seedChatActivity records preview ids without unread counts', () => {
    const seeded = seedChatActivity({}, [chat])
    expect(seeded.c1?.lastSeenPreviewId).toBe('p1')
    expect(seeded.c1?.unreadCount).toBe(0)
    expect(seeded.c1?.mentionCount).toBe(0)
    expect(seeded.c1?.lastSenderName).toBe('Other')
  })

  test('markChatUnread increments unread and markChatRead clears counts', () => {
    const unread = markChatUnread(seedChatActivity({}, [chat]), {
      ...chat,
      lastMessagePreview: { ...chat.lastMessagePreview, id: 'p2' },
    })
    expect(unread.c1?.unreadCount).toBe(1)
    const mentioned = bumpChatMention(unread, 'c1')
    expect(mentioned.c1?.mentionCount).toBe(1)
    const read = markChatRead(mentioned, 'c1', 'p2')
    expect(read.c1?.unreadCount).toBe(0)
    expect(read.c1?.mentionCount).toBe(0)
    expect(read.c1?.lastSeenPreviewId).toBe('p2')
  })

  test('unread totals and recent notifications aggregate active chats', () => {
    const activity = {
      c1: {
        unreadCount: 2,
        mentionCount: 1,
        lastActivityAt: '2026-04-29T10:00:00Z',
      },
      c2: {
        unreadCount: 1,
        mentionCount: 0,
        lastActivityAt: '2026-04-29T11:00:00Z',
      },
      c3: { unreadCount: 0, mentionCount: 0 },
    }
    expect(unreadTotals(activity)).toEqual({ unreadCount: 3, mentionCount: 1, chats: 2 })
    expect(recentUnreadNotifications(activity).map((x) => x.chatId)).toEqual(['c2', 'c1'])
  })
})

describe('message cursor helpers', () => {
  test('clamps cursors into message bounds', () => {
    expect(clampMessageCursor(-10, 3)).toBe(0)
    expect(clampMessageCursor(99, 3)).toBe(2)
    expect(clampMessageCursor(1.8, 3)).toBe(1)
    expect(clampMessageCursor(4, 0)).toBe(0)
  })

  test('moves from the end by default and stores clamped per-convo cursor', () => {
    expect(moveMessageCursor(undefined, -1, 5)).toBe(3)
    expect(moveMessageCursor(0, -1, 5)).toBe(0)
    expect(setMessageCursor({}, 'chat:c1', 10, 4)).toEqual({ 'chat:c1': 3 })
  })
})
