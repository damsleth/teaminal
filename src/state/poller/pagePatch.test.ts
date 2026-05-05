import { describe, expect, test } from 'bun:test'
import type { ChatMessage } from '../../types'
import { initialAppState, type AppState, type ConvKey, type Focus } from '../store'
import { mergeActivePagePatch, type MessagesPage } from './pagePatch'

function message(id: string, ts: string, opts?: Partial<ChatMessage>): ChatMessage {
  return {
    id,
    createdDateTime: ts,
    body: { contentType: 'text', content: id },
    ...opts,
  }
}

function appStateWith(overrides?: Partial<AppState>): AppState {
  return { ...initialAppState(), ...overrides }
}

describe('mergeActivePagePatch', () => {
  const conv: ConvKey = 'chat:c1'
  const focus: Focus = { kind: 'chat', chatId: 'c1' }

  test('merges page into empty cache, sets nextLink and fullyLoaded', () => {
    const state = appStateWith()
    const page: MessagesPage = {
      messages: [message('m1', '2026-01-01T00:00:00Z'), message('m2', '2026-01-01T00:00:01Z')],
      nextLink: 'https://graph/next',
    }
    const patch = mergeActivePagePatch(state, conv, page, focus)
    expect(patch.messageCacheByConvo?.[conv]?.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(patch.messageCacheByConvo?.[conv]?.nextLink).toBe('https://graph/next')
    expect(patch.messageCacheByConvo?.[conv]?.fullyLoaded).toBe(false)
    expect(patch.messageCacheByConvo?.[conv]?.loadingOlder).toBe(false)
  })

  test('marks fullyLoaded when no nextLink', () => {
    const state = appStateWith()
    const page: MessagesPage = {
      messages: [message('m1', '2026-01-01T00:00:00Z')],
    }
    const patch = mergeActivePagePatch(state, conv, page, focus)
    expect(patch.messageCacheByConvo?.[conv]?.fullyLoaded).toBe(true)
  })

  test('preserves older cached pages and their nextLink when the new page does not include them', () => {
    const state = appStateWith({
      messageCacheByConvo: {
        [conv]: {
          messages: [message('m0', '2026-01-01T00:00:00Z'), message('m1', '2026-01-01T00:00:01Z')],
          nextLink: 'https://graph/older',
          loadingOlder: false,
          fullyLoaded: false,
        },
      },
    })
    const page: MessagesPage = {
      messages: [message('m1', '2026-01-01T00:00:01Z'), message('m2', '2026-01-01T00:00:02Z')],
    }
    const patch = mergeActivePagePatch(state, conv, page, focus)
    expect(patch.messageCacheByConvo?.[conv]?.messages.map((m) => m.id)).toEqual(['m0', 'm1', 'm2'])
    expect(patch.messageCacheByConvo?.[conv]?.nextLink).toBe('https://graph/older')
    expect(patch.messageCacheByConvo?.[conv]?.fullyLoaded).toBe(false)
  })

  test('preserves optimistic _sending messages across the merge', () => {
    const state = appStateWith({
      messageCacheByConvo: {
        [conv]: {
          messages: [
            message('m1', '2026-01-01T00:00:00Z'),
            message('temp-1', '2026-01-01T00:00:01Z', {
              _sending: true,
              _tempId: 'temp-1',
            }),
          ],
          loadingOlder: false,
          fullyLoaded: true,
        },
      },
    })
    const page: MessagesPage = {
      messages: [message('m1', '2026-01-01T00:00:00Z')],
    }
    const patch = mergeActivePagePatch(state, conv, page, focus)
    const merged = patch.messageCacheByConvo?.[conv]?.messages ?? []
    expect(merged.map((m) => m.id)).toEqual(['m1', 'temp-1'])
    expect(merged[1]?._sending).toBe(true)
  })

  test('clamps an out-of-bounds existing cursor', () => {
    const state = appStateWith({
      messageCursorByConvo: { [conv]: 99 },
    })
    const page: MessagesPage = {
      messages: [message('m1', '2026-01-01T00:00:00Z'), message('m2', '2026-01-01T00:00:01Z')],
    }
    const patch = mergeActivePagePatch(state, conv, page, focus)
    expect(patch.messageCursorByConvo?.[conv]).toBe(1)
  })

  test('seeds the cursor at the newest index when no cursor exists', () => {
    const state = appStateWith()
    const page: MessagesPage = {
      messages: [message('m1', '2026-01-01T00:00:00Z'), message('m2', '2026-01-01T00:00:01Z')],
    }
    const patch = mergeActivePagePatch(state, conv, page, focus)
    expect(patch.messageCursorByConvo?.[conv]).toBe(1)
  })

  test('marks the chat read for chat focus, with the newest message id', () => {
    const state = appStateWith({
      unreadByChatId: { c1: { unreadCount: 3, mentionCount: 1 } },
    })
    const page: MessagesPage = {
      messages: [message('m1', '2026-01-01T00:00:00Z'), message('m2', '2026-01-01T00:00:01Z')],
    }
    const patch = mergeActivePagePatch(state, conv, page, focus)
    expect(patch.unreadByChatId?.c1?.unreadCount).toBe(0)
    expect(patch.unreadByChatId?.c1?.mentionCount).toBe(0)
    expect(patch.unreadByChatId?.c1?.lastSeenPreviewId).toBe('m2')
  })

  test('does not include unreadByChatId in the patch when focus is a channel', () => {
    const state = appStateWith({
      unreadByChatId: { c1: { unreadCount: 3, mentionCount: 1 } },
    })
    const page: MessagesPage = {
      messages: [message('m1', '2026-01-01T00:00:00Z')],
    }
    const channelFocus: Focus = { kind: 'channel', teamId: 't1', channelId: 'ch1' }
    const channelConv: ConvKey = 'channel:t1:ch1'
    const patch = mergeActivePagePatch(state, channelConv, page, channelFocus)
    expect(patch.unreadByChatId).toBeUndefined()
  })
})
