import { describe, expect, test } from 'bun:test'
import type { Key } from 'ink'
import { handleListKeys, type ListKeysCtx } from './listKeys'
import { createAppStore } from '../../state/store'
import type { Chat } from '../../types'

function makeKey(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...overrides,
  } as Key
}

function chat(id: string, members: string[] = []): Chat {
  return {
    id,
    chatType: 'oneOnOne',
    createdDateTime: '2026-01-01T00:00:00Z',
    topic: id,
    members: members.map((u) => ({ id: u, userId: u, displayName: u })),
  }
}

function makeCtx(opts?: Partial<ListKeysCtx>): {
  ctx: ListKeysCtx
  store: ReturnType<typeof createAppStore>
  exits: number
  refreshes: number
  hardRefreshes: number
  newChats: string[]
} {
  const store = createAppStore()
  let exits = 0
  let refreshes = 0
  let hardRefreshes = 0
  const newChats: string[] = []
  const ctx: ListKeysCtx = {
    store,
    me: { id: 'me', displayName: 'Me', userPrincipalName: 'me@x', mail: null },
    chats: [chat('a'), chat('b'), chat('c')],
    teams: [],
    channelsByTeam: {},
    filter: '',
    cursor: 0,
    focus: { kind: 'list' },
    exit: () => {
      exits++
    },
    refresh: () => {
      refreshes++
    },
    hardRefresh: () => {
      hardRefreshes++
    },
    openNewChatPrompt: (q) => {
      newChats.push(q ?? '')
    },
    ...opts,
  }
  return {
    ctx,
    store,
    get exits() {
      return exits
    },
    get refreshes() {
      return refreshes
    },
    get hardRefreshes() {
      return hardRefreshes
    },
    newChats,
  }
}

describe('handleListKeys', () => {
  test('Ctrl+C exits', () => {
    const a = makeCtx()
    expect(handleListKeys({ input: 'c', key: makeKey({ ctrl: true }) }, a.ctx)).toBe('handled')
    expect(a.exits).toBe(1)
  })

  test('q exits when in list focus', () => {
    const a = makeCtx()
    handleListKeys({ input: 'q', key: makeKey() }, a.ctx)
    expect(a.exits).toBe(1)
  })

  test('r calls refresh', () => {
    const a = makeCtx()
    handleListKeys({ input: 'r', key: makeKey() }, a.ctx)
    expect(a.refreshes).toBe(1)
  })

  test('Shift+R calls hard refresh', () => {
    const a = makeCtx()
    handleListKeys({ input: 'R', key: makeKey() }, a.ctx)
    expect(a.hardRefreshes).toBe(1)
    expect(a.refreshes).toBe(0)
  })

  test('/ enters filter mode', () => {
    const a = makeCtx()
    handleListKeys({ input: '/', key: makeKey() }, a.ctx)
    expect(a.store.get().inputZone).toBe('filter')
  })

  test('? opens the keybinds modal', () => {
    const a = makeCtx()
    handleListKeys({ input: '?', key: makeKey() }, a.ctx)
    expect(a.store.get().modal?.kind).toBe('keybinds')
  })

  test('n opens the new-chat prompt with the current filter case-insensitively', () => {
    const a = makeCtx({ filter: 'Carl' })
    handleListKeys({ input: 'N', key: makeKey() }, a.ctx)
    handleListKeys({ input: 'n', key: makeKey() }, a.ctx)
    expect(a.newChats).toEqual(['Carl', 'Carl'])
  })

  test('j moves cursor down', () => {
    const a = makeCtx({ cursor: 0 })
    handleListKeys({ input: 'j', key: makeKey() }, a.ctx)
    expect(a.store.get().cursor).toBe(1)
  })

  test('down arrow moves cursor down', () => {
    const a = makeCtx({ cursor: 0 })
    handleListKeys({ input: '', key: makeKey({ downArrow: true }) }, a.ctx)
    expect(a.store.get().cursor).toBe(1)
  })

  test('k moves cursor up', () => {
    const a = makeCtx({ cursor: 1 })
    handleListKeys({ input: 'k', key: makeKey() }, a.ctx)
    expect(a.store.get().cursor).toBe(0)
  })

  test('u moves cursor up half a page in the sidebar', () => {
    const chats = Array.from({ length: 20 }, (_, i) => chat(`c${i}`))
    const a = makeCtx({ chats, cursor: 15 })
    handleListKeys({ input: 'u', key: makeKey() }, a.ctx)
    expect(a.store.get().cursor).toBe(5)
  })

  test('d moves cursor down half a page in the sidebar', () => {
    const chats = Array.from({ length: 20 }, (_, i) => chat(`c${i}`))
    const a = makeCtx({ chats, cursor: 5 })
    handleListKeys({ input: 'd', key: makeKey() }, a.ctx)
    expect(a.store.get().cursor).toBe(15)
  })

  test('Enter on a chat row sets focus to that chat', () => {
    const a = makeCtx({ cursor: 1 })
    handleListKeys({ input: '', key: makeKey({ return: true }) }, a.ctx)
    const focus = a.store.get().focus
    expect(focus.kind).toBe('chat')
    expect(focus.kind === 'chat' && focus.chatId).toBe('b')
  })

  test('h is handled (no-op) so it does not fall through', () => {
    const a = makeCtx()
    expect(handleListKeys({ input: 'h', key: makeKey() }, a.ctx)).toBe('handled')
    // No state change.
    expect(a.store.get().focus.kind).toBe('list')
  })

  test('Esc opens the menu modal when no chat is focused', () => {
    const a = makeCtx()
    handleListKeys({ input: '', key: makeKey({ escape: true }) }, a.ctx)
    expect(a.store.get().modal?.kind).toBe('menu')
  })

  test('Esc with empty list still opens the menu', () => {
    const a = makeCtx({ chats: [] })
    handleListKeys({ input: '', key: makeKey({ escape: true }) }, a.ctx)
    expect(a.store.get().modal?.kind).toBe('menu')
  })

  test('Filter that matches no items but looks like a name → synthetic new-chat row', () => {
    const a = makeCtx({ filter: 'Carl', chats: [], cursor: 0 })
    handleListKeys({ input: '', key: makeKey({ return: true }) }, a.ctx)
    expect(a.newChats).toEqual(['Carl'])
  })
})
