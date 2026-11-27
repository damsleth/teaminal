import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountRef } from '../account'
import { accountStore, openAccount, setForeground } from '../state/accountStore'
import { applySeededState } from '../state/seedFixtures'
import { createAppStore } from '../state/store'
import { contextMenuEntries } from './contextMenuEntries'

// Favorite toggles persist to config.json: point that write at a temp dir
// (the path is resolved when the toggle runs).
let configHome: string
const prevConfigHome = process.env.XDG_CONFIG_HOME
beforeAll(() => {
  configHome = mkdtempSync(join(tmpdir(), 'teaminal-ctx-menu-'))
  process.env.XDG_CONFIG_HOME = configHome
})
afterAll(() => {
  if (prevConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = prevConfigHome
  rmSync(configHome, { recursive: true, force: true })
})

function seeded() {
  const store = createAppStore(accountRef(null))
  applySeededState(accountStore(store))
  return store
}

test('a chat row offers open, read toggle, favorite and delete, each with its key', () => {
  const store = seeded()
  const chat = store.get().chats[0]!
  const entries = contextMenuEntries({ kind: 'chat', chatId: chat.id, label: 'Ada' }, store.get(), {
    store,
  })
  expect(entries.map((e) => [e.id, e.key])).toEqual([
    ['open', 'Enter'],
    ['toggle-read', 'm'],
    ['favorite', 'f'],
    ['cross-favorite', 'Ctrl+F'],
    ['delete', 'Ctrl+D'],
  ])
  entries[0]!.run()
  expect(store.get().focus).toEqual({ kind: 'chat', chatId: chat.id })
  entries[4]!.run()
  expect(store.get().modal?.kind).toBe('confirm-delete-chat')
})

test('the favorite entry toggles the row in its own account and names the next action', () => {
  const store = createAppStore()
  applySeededState(openAccount(store, accountRef('alpha'), { foreground: true }), 'alpha')
  applySeededState(openAccount(store, accountRef('beta'), { foreground: false }), 'beta')
  const chat = store.get().chats[0]!
  const target = { kind: 'chat' as const, chatId: chat.id, label: 'Ada', alias: 'beta' }
  const favorite = () =>
    contextMenuEntries(target, store.get(), { store }).find((e) => e.id === 'favorite')!
  expect(favorite().label).toBe('Add to favorites')
  favorite().run()
  expect(store.get().settings.favoritesByAccount).toEqual({ beta: [`chat:${chat.id}`] })
  // No account switch.
  expect(store.get().account?.id).toBe(accountRef('alpha').id)
  expect(favorite().label).toBe('Remove from favorites')
  favorite().run()
  expect(store.get().settings.favoritesByAccount).toEqual({})
  // The cross-account entry keeps its own list, keyed by the row's account.
  const cross = () =>
    contextMenuEntries(target, store.get(), { store }).find((e) => e.id === 'cross-favorite')!
  expect(cross().label).toBe('Add to cross-account favorites')
  cross().run()
  expect(store.get().settings.crossAccountFavorites).toEqual({ beta: [`chat:${chat.id}`] })
  expect(store.get().settings.favoritesByAccount).toEqual({})
  expect(cross().label).toBe('Remove from cross-account favorites')
})

test('a channel row offers open and favorite', () => {
  const store = seeded()
  const target = { kind: 'channel' as const, teamId: 't1', channelId: 'c1', label: 'General' }
  const entries = contextMenuEntries(target, store.get(), { store })
  expect(entries.map((e) => [e.id, e.key])).toEqual([
    ['open', 'Enter'],
    ['favorite', 'f'],
    ['cross-favorite', 'Ctrl+F'],
  ])
  entries[1]!.run()
  // The default profile's favorites are stored under ''.
  expect(store.get().settings.favoritesByAccount).toEqual({ '': ['channel:t1/c1'] })
  entries[0]!.run()
  expect(store.get().focus).toEqual({ kind: 'channel', teamId: 't1', channelId: 'c1' })
})

test("someone else's message can be reacted to; your own can also be edited and deleted", () => {
  const store = seeded()
  const s = store.get()
  const [conv, msgs] = Object.entries(s.messagesByConvo).find(([k]) => k.startsWith('chat:'))!
  const chatId = conv.slice('chat:'.length)
  const focus = { kind: 'chat' as const, chatId }
  const other = msgs.find((m) => m.from?.user?.id !== s.me?.id)!
  const ids = (messageId: string) =>
    contextMenuEntries({ kind: 'message', focus, messageId }, store.get(), { store }).map(
      (e) => e.id,
    )
  expect(ids(other.id)).toEqual(['react', 'edit-reactions'])
  const own = msgs.find((m) => m.from?.user?.id === s.me?.id)
  if (own) expect(ids(own.id)).toEqual(['react', 'edit-reactions', 'edit', 'delete'])
})

test('a channel message offers its thread', () => {
  const store = seeded()
  const opened: string[] = []
  const focus = { kind: 'channel' as const, teamId: 't', channelId: 'c' }
  store.set({
    messagesByConvo: {
      ...store.get().messagesByConvo,
      'channel:t:c': [
        {
          id: 'root',
          createdDateTime: '2026-01-01T00:00:00Z',
          messageType: 'message',
          body: { contentType: 'text', content: 'hi' },
        },
      ],
    },
  })
  const entries = contextMenuEntries({ kind: 'message', focus, messageId: 'root' }, store.get(), {
    store,
    openThread: (_f, id) => opened.push(id),
  })
  expect(entries.map((e) => e.id)).toEqual(['thread'])
  entries[0]!.run()
  expect(opened).toEqual(['root'])
})

test('a chat row of a background account acts on that account’s chat (unified sidebar)', () => {
  // alpha in front, beta behind; the same chat id in both.
  const store = createAppStore()
  applySeededState(openAccount(store, accountRef('alpha'), { foreground: true }), 'alpha')
  applySeededState(openAccount(store, accountRef('beta'), { foreground: false }), 'beta')
  const chat = store.get().chats[0]!
  const betaId = accountRef('beta').id
  const swaps: string[] = []
  const entries = () =>
    contextMenuEntries(
      { kind: 'chat', chatId: chat.id, label: 'ADA', alias: 'beta' },
      store.get(),
      {
        store,
        toForeground: (alias) => {
          swaps.push(alias)
          setForeground(store, accountRef(alias).id, { restoreUi: false })
        },
      },
    )
  // Mark read/unread flips beta's mark only, without a swap.
  const before = store.get().unreadByChatId[chat.id]
  entries()
    .find((e) => e.id === 'toggle-read')!
    .run()
  expect(store.get().unreadByChatId[chat.id]).toEqual(before)
  expect(store.get().backgroundAccounts[betaId]!.unreadByChatId[chat.id]).not.toEqual(
    store.get().unreadByChatId[chat.id],
  )
  // Delete names beta; Open brings beta to the front first.
  entries()
    .find((e) => e.id === 'delete')!
    .run()
  expect(store.get().modal).toMatchObject({ kind: 'confirm-delete-chat', alias: 'beta' })
  expect(swaps).toEqual([])
  entries()
    .find((e) => e.id === 'open')!
    .run()
  expect(swaps).toEqual(['beta'])
  expect(store.get().account?.id).toBe(betaId)
  expect(store.get().focus).toEqual({ kind: 'chat', chatId: chat.id })
})

test('split panes: rows offer "Open in other pane" only while split, not for the row there', () => {
  const store = seeded()
  const [first, second] = store.get().chats
  const ids = (chatId: string) =>
    contextMenuEntries({ kind: 'chat', chatId, label: 'x' }, store.get(), { store }).map(
      (e) => e.id,
    )
  const channel = { kind: 'channel' as const, teamId: 't1', channelId: 'c1', label: 'General' }
  const channelIds = () => contextMenuEntries(channel, store.get(), { store }).map((e) => e.id)
  // No split: the menus are unchanged.
  expect(ids(second!.id)).not.toContain('open-other-pane')
  expect(channelIds()).not.toContain('open-other-pane')

  store.set({ split: { focus: { kind: 'chat', chatId: first!.id }, side: 'right' } })
  expect(ids(first!.id)).not.toContain('open-other-pane')
  expect(channelIds()).toEqual(['open', 'open-other-pane', 'favorite', 'cross-favorite'])
  const entry = contextMenuEntries({ kind: 'chat', chatId: second!.id, label: 'x' }, store.get(), {
    store,
  }).find((e) => e.id === 'open-other-pane')!
  expect([entry.label, entry.key]).toEqual(['Open in other pane', 'v'])
  entry.run()
  expect(store.get().split).toEqual({ focus: { kind: 'chat', chatId: second!.id }, side: 'right' })
})

test("split panes: another account's row has no other-pane entry", () => {
  const store = createAppStore()
  applySeededState(openAccount(store, accountRef('alpha'), { foreground: true }), 'alpha')
  applySeededState(openAccount(store, accountRef('beta'), { foreground: false }), 'beta')
  const chat = store.get().chats[1]!
  store.set({ split: { focus: { kind: 'list' }, side: 'right' } })
  const entries = (alias: string) =>
    contextMenuEntries({ kind: 'chat', chatId: chat.id, label: 'x', alias }, store.get(), {
      store,
    }).map((e) => e.id)
  expect(entries('beta')).not.toContain('open-other-pane')
  expect(entries('alpha')).toContain('open-other-pane')
})
