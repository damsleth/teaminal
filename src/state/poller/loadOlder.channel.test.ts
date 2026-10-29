import { expect, mock, test } from 'bun:test'
import { accountRef } from '../../account'
import { createGraphClient, currentAccountContext } from '../../graph/client'
import type { ChatMessage } from '../../types'
import { accountStore } from '../accountStore'
import { createAppStore, type ConvKey } from '../store'

// Channel pages come from the Teams chat service; stub the page calls.
let firstPage: { messages: ChatMessage[]; nextLink?: string } = { messages: [] }
let firstPageCalls = 0
mock.module('../../graph/teams', () => ({
  listChannelMessagesPage: async () => {
    firstPageCalls++
    return firstPage
  },
  listChannelMessagesNextPage: async () => ({ messages: [] }),
}))
const { loadOlderMessages } = await import('./loadOlder')

const msg = (id: string): ChatMessage => ({
  id,
  createdDateTime: '2026-01-01T00:00:00Z',
  messageType: 'message',
  body: { contentType: 'text', content: id },
})

async function run(): Promise<{ fullyLoaded: boolean; nextLink?: string }> {
  const store = createAppStore(accountRef('test'))
  const conv: ConvKey = 'channel:t1:ch1'
  store.set({
    focus: { kind: 'channel', teamId: 't1', channelId: 'ch1' },
    messageCacheByConvo: {
      [conv]: { messages: [msg('m1')], loadingOlder: false, fullyLoaded: false },
    },
  })
  await loadOlderMessages({
    getClient: () => createGraphClient(currentAccountContext()),
    store: accountStore(store),
    focus: store.get().focus,
    reportError: () => {},
  })
  const cache = store.get().messageCacheByConvo[conv]!
  return { fullyLoaded: cache.fullyLoaded, nextLink: cache.nextLink }
}

test('a channel without a cursor refetches its first page to recover one', async () => {
  firstPageCalls = 0
  firstPage = { messages: [msg('m1'), msg('m0')], nextLink: 'https://chatsvc/next' }
  expect(await run()).toEqual({ fullyLoaded: false, nextLink: 'https://chatsvc/next' })
  expect(firstPageCalls).toBe(1)
})

test('a single-page channel is fully loaded after that fetch', async () => {
  firstPage = { messages: [msg('m1')] }
  expect((await run()).fullyLoaded).toBe(true)
})
