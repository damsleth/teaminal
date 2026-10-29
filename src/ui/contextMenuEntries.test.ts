import { expect, test } from 'bun:test'
import { applySeededState } from '../state/seedFixtures'
import { createAppStore } from '../state/store'
import { contextMenuEntries } from './contextMenuEntries'

function seeded() {
  const store = createAppStore()
  applySeededState(store)
  return store
}

test('a chat row offers open, read toggle and delete, each with its key', () => {
  const store = seeded()
  const chat = store.get().chats[0]!
  const entries = contextMenuEntries({ kind: 'chat', chatId: chat.id, label: 'Ada' }, store.get(), {
    store,
  })
  expect(entries.map((e) => [e.id, e.key])).toEqual([
    ['open', 'Enter'],
    ['toggle-read', 'm'],
    ['delete', 'Ctrl+D'],
  ])
  entries[0]!.run()
  expect(store.get().focus).toEqual({ kind: 'chat', chatId: chat.id })
  entries[2]!.run()
  expect(store.get().modal?.kind).toBe('confirm-delete-chat')
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
