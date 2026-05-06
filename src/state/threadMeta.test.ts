import { afterEach, describe, expect, test } from 'bun:test'
import {
  __resetThreadMetaForTests,
  __setReplyFetcherForTests,
  scheduleReplyCountFetch,
  selectRootsToCheck,
  shouldRefreshThreadMeta,
} from './threadMeta'
import { createAppStore } from './store'
import type { ChatMessage } from '../types'

const ROOT = (id: string, override?: Partial<ChatMessage>): ChatMessage => ({
  id,
  createdDateTime: '2026-05-05T00:00:00Z',
  body: { contentType: 'text', content: 'x' },
  ...override,
})

afterEach(() => {
  __resetThreadMetaForTests()
  __setReplyFetcherForTests(null)
})

describe('shouldRefreshThreadMeta', () => {
  test('refreshes missing entries', () => {
    expect(shouldRefreshThreadMeta(undefined, 1000)).toBe(true)
  })

  test('refreshes stale entries', () => {
    expect(shouldRefreshThreadMeta({ count: 1, more: false, checkedAt: 0 }, 5 * 60_000 + 1)).toBe(
      true,
    )
  })

  test('keeps fresh entries', () => {
    expect(shouldRefreshThreadMeta({ count: 1, more: false, checkedAt: 0 }, 1_000)).toBe(false)
  })
})

describe('selectRootsToCheck', () => {
  test('skips replies and system events; caps at limit', () => {
    const messages = [
      ROOT('a'),
      ROOT('b', { replyToId: 'a' }),
      ROOT('c', { messageType: 'systemEventMessage' }),
      ROOT('d'),
      ROOT('e'),
      ROOT('f'),
      ROOT('g'),
      ROOT('h'),
    ]
    const ids = selectRootsToCheck(messages, {}, 0, 3)
    expect(ids).toEqual(['a', 'd', 'e'])
  })

  test('skips roots with fresh meta', () => {
    const messages = [ROOT('a'), ROOT('b')]
    const meta = { a: { count: 2, more: false, checkedAt: 1000 } }
    expect(selectRootsToCheck(messages, meta, 1500)).toEqual(['b'])
  })
})

describe('scheduleReplyCountFetch', () => {
  test('writes thread meta from fetcher', async () => {
    const store = createAppStore()
    __setReplyFetcherForTests(async (_t, _c, rootId) => ({
      messages: rootId === 'a' ? [ROOT('r1', { replyToId: 'a' })] : [],
    }))
    await scheduleReplyCountFetch({
      store,
      teamId: 't1',
      channelId: 'c1',
      rootMessages: [ROOT('a'), ROOT('b')],
      now: 0,
    })
    const meta = store.get().threadMetaByRoot
    expect(meta.a?.count).toBe(1)
    expect(meta.a?.more).toBe(false)
    expect(meta.b?.count).toBe(0)
  })

  test('marks more when nextLink present', async () => {
    const store = createAppStore()
    __setReplyFetcherForTests(async () => ({
      messages: [ROOT('r1', { replyToId: 'a' })],
      nextLink: 'https://graph/next',
    }))
    await scheduleReplyCountFetch({
      store,
      teamId: 't1',
      channelId: 'c1',
      rootMessages: [ROOT('a')],
      now: 0,
    })
    expect(store.get().threadMetaByRoot.a?.more).toBe(true)
  })

  test('per-channel debounce skips a second batch within the window', async () => {
    const store = createAppStore()
    let calls = 0
    __setReplyFetcherForTests(async () => {
      calls++
      return { messages: [] }
    })
    await scheduleReplyCountFetch({
      store,
      teamId: 't1',
      channelId: 'c1',
      rootMessages: [ROOT('a')],
      now: 0,
    })
    await scheduleReplyCountFetch({
      store,
      teamId: 't1',
      channelId: 'c1',
      rootMessages: [ROOT('b')],
      now: 5000,
    })
    expect(calls).toBe(1)
  })

  test('different channels are independent', async () => {
    const store = createAppStore()
    let calls = 0
    __setReplyFetcherForTests(async () => {
      calls++
      return { messages: [] }
    })
    await scheduleReplyCountFetch({
      store,
      teamId: 't1',
      channelId: 'c1',
      rootMessages: [ROOT('a')],
      now: 0,
    })
    await scheduleReplyCountFetch({
      store,
      teamId: 't1',
      channelId: 'c2',
      rootMessages: [ROOT('b')],
      now: 1000,
    })
    expect(calls).toBe(2)
  })
})
