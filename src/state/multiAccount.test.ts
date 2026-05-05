import { describe, expect, test } from 'bun:test'
import { createAppStore, resetAccountScopedState } from '../state/store'
import { getMessageCachePath } from '../state/messageCachePersistence'

describe('resetAccountScopedState', () => {
  test('clears account-scoped slices and preserves settings + terminalFocused', () => {
    const store = createAppStore()
    store.set({
      me: { id: 'me', displayName: 'Me', userPrincipalName: 'me@x', mail: null },
      chats: [
        {
          id: 'c1',
          chatType: 'oneOnOne',
          createdDateTime: '2026-01-01T00:00:00Z',
        },
      ],
      teams: [{ id: 't1', displayName: 'T1' }],
      channelsByTeam: { t1: [{ id: 'ch1', displayName: 'general' }] },
      messagesByConvo: {
        'chat:c1': [
          {
            id: 'm1',
            createdDateTime: '2026-01-01T00:00:00Z',
            body: { contentType: 'text', content: 'hi' },
          },
        ],
      },
      messageCacheByConvo: {
        'chat:c1': { messages: [], loadingOlder: false, fullyLoaded: false },
      },
      draftsByConvo: { 'chat:c1': 'half-typed' },
      unreadByChatId: { c1: { unreadCount: 1, mentionCount: 1 } },
      focus: { kind: 'chat', chatId: 'c1' },
      filter: 'foo',
      myPresence: { id: 'me', availability: 'Available', activity: 'Available' },
      memberPresence: { other: { id: 'other', availability: 'Away', activity: 'Away' } },
      typingByConvo: { 'chat:c1': [{ userId: 'x', displayName: 'X', startedAt: 0 }] },
      conn: 'online',
      realtimeState: 'connected',
      terminalFocused: true,
      settings: { ...store.get().settings, theme: 'light' },
    })

    resetAccountScopedState(store)

    const s = store.get()
    expect(s.me).toBeUndefined()
    expect(s.chats).toEqual([])
    expect(s.teams).toEqual([])
    expect(s.channelsByTeam).toEqual({})
    expect(s.messagesByConvo).toEqual({})
    expect(s.messageCacheByConvo).toEqual({})
    expect(s.draftsByConvo).toEqual({})
    expect(s.unreadByChatId).toEqual({})
    expect(s.focus).toEqual({ kind: 'list' })
    expect(s.filter).toBe('')
    expect(s.myPresence).toBeUndefined()
    expect(s.memberPresence).toEqual({})
    expect(s.typingByConvo).toEqual({})
    expect(s.conn).toBe('connecting')
    expect(s.realtimeState).toBe('off')
    expect(s.modal).toBeNull()
    expect(s.capabilities).toBeUndefined()

    // Preserved
    expect(s.terminalFocused).toBe(true)
    expect(s.settings.theme).toBe('light')
  })
})

describe('getMessageCachePath profile scoping', () => {
  test('default profile uses the legacy path', () => {
    const path = getMessageCachePath({ HOME: '/tmp/home', XDG_CACHE_HOME: '/tmp/cache' }, null)
    expect(path).toBe('/tmp/cache/teaminal/messages.json')
  })

  test('named profile gets its own filename', () => {
    const path = getMessageCachePath({ HOME: '/tmp/home', XDG_CACHE_HOME: '/tmp/cache' }, 'work')
    expect(path).toBe('/tmp/cache/teaminal/messages.work.json')
  })

  test('odd profile names get slugified', () => {
    const path = getMessageCachePath(
      { HOME: '/tmp/home', XDG_CACHE_HOME: '/tmp/cache' },
      'foo bar/baz',
    )
    expect(path).toContain('messages.foo_bar_baz.json')
  })
})
