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

/**
 * Messages for `conv` after applying the patch, read the way the app reads
 * them. The patch omits keys that did not change (so a no-op poll notifies
 * nothing), which means assertions about content must look at the merged
 * state rather than at patch shape.
 */
function messagesAfter(state: AppState, patch: Partial<AppState>, key: ConvKey): ChatMessage[] {
  const next = { ...state, ...patch }
  return next.messageCacheByConvo[key]?.messages ?? next.messagesByConvo[key] ?? []
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

  test('rescues optimistic _sending messages that live only in messagesByConvo', () => {
    // Simulates the Composer path: optimistic row is written to
    // messagesByConvo but not yet mirrored into messageCacheByConvo.
    const state = appStateWith({
      messageCacheByConvo: {
        [conv]: {
          messages: [message('m1', '2026-01-01T00:00:00Z')],
          loadingOlder: false,
          fullyLoaded: true,
        },
      },
      messagesByConvo: {
        [conv]: [
          message('m1', '2026-01-01T00:00:00Z'),
          message('temp-ui', '2026-01-01T00:00:02Z', {
            _sending: true,
            _tempId: 'temp-ui',
          }),
        ],
      },
    })
    const page: MessagesPage = {
      messages: [message('m1', '2026-01-01T00:00:00Z')],
    }
    const patch = mergeActivePagePatch(state, conv, page, focus)
    const cacheMerged = patch.messageCacheByConvo?.[conv]?.messages ?? []
    expect(cacheMerged.map((m) => m.id)).toEqual(['m1', 'temp-ui'])
    expect(cacheMerged[1]?._sending).toBe(true)
    // The legacy mirror already held the rescued row, so the patch correctly
    // omits messagesByConvo; assert on the merged state instead of the patch.
    const legacyMerged = { ...state, ...patch }.messagesByConvo[conv] ?? []
    expect(legacyMerged.map((m) => m.id)).toEqual(['m1', 'temp-ui'])
  })

  test('rescues optimistic _sendError messages that live only in messagesByConvo', () => {
    const state = appStateWith({
      messageCacheByConvo: {
        [conv]: {
          messages: [message('m1', '2026-01-01T00:00:00Z')],
          loadingOlder: false,
          fullyLoaded: true,
        },
      },
      messagesByConvo: {
        [conv]: [
          message('m1', '2026-01-01T00:00:00Z'),
          message('temp-err', '2026-01-01T00:00:02Z', {
            _sendError: 'boom',
            _tempId: 'temp-err',
          }),
        ],
      },
    })
    const page: MessagesPage = {
      messages: [message('m1', '2026-01-01T00:00:00Z')],
    }
    const patch = mergeActivePagePatch(state, conv, page, focus)
    const merged = messagesAfter(state, patch, conv)
    expect(merged.map((m) => m.id)).toEqual(['m1', 'temp-err'])
    expect(merged[1]?._sendError).toBe('boom')
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
    const merged = messagesAfter(state, patch, conv)
    expect(merged.map((m) => m.id)).toEqual(['m1', 'temp-1'])
    expect(merged[1]?._sending).toBe(true)
  })

  // -------------------------------------------------------------------------
  // No-op polls must not notify. Store.set compares by reference, so any key
  // present in the patch wakes every useAppState subscriber and re-reconciles
  // the message pane. Before this guard the active loop did that every 5s.
  // -------------------------------------------------------------------------
  test('a poll returning identical messages produces an empty patch', () => {
    const messages = [message('m1', '2026-01-01T00:00:00Z'), message('m2', '2026-01-01T00:00:01Z')]
    const state = appStateWith({
      messageCacheByConvo: {
        [conv]: { messages, loadingOlder: false, fullyLoaded: true },
      },
      messagesByConvo: { [conv]: messages },
      messageCursorByConvo: { [conv]: 1 },
      nameByUserId: {},
      unreadByChatId: { c1: { unreadCount: 0, mentionCount: 0, lastSeenPreviewId: 'm2' } },
    })
    // Fresh objects, same content — exactly what a real poll returns.
    const page: MessagesPage = {
      messages: [message('m1', '2026-01-01T00:00:00Z'), message('m2', '2026-01-01T00:00:01Z')],
    }
    const patch = mergeActivePagePatch(state, conv, page, focus)
    expect(Object.keys(patch)).toEqual([])
  })

  test('an identical poll preserves array identity for the message list', () => {
    const messages = [message('m1', '2026-01-01T00:00:00Z')]
    const state = appStateWith({
      messageCacheByConvo: {
        [conv]: { messages, loadingOlder: false, fullyLoaded: true },
      },
      messagesByConvo: { [conv]: messages },
      messageCursorByConvo: { [conv]: 0 },
      unreadByChatId: { c1: { unreadCount: 0, mentionCount: 0, lastSeenPreviewId: 'm1' } },
    })
    const page: MessagesPage = { messages: [message('m1', '2026-01-01T00:00:00Z')] }
    const next = { ...state, ...mergeActivePagePatch(state, conv, page, focus) }
    expect(next.messageCacheByConvo[conv]?.messages).toBe(messages)
    expect(next.messagesByConvo[conv]).toBe(messages)
  })

  test('a genuinely new message still produces a patch', () => {
    const messages = [message('m1', '2026-01-01T00:00:00Z')]
    const state = appStateWith({
      messageCacheByConvo: {
        [conv]: { messages, loadingOlder: false, fullyLoaded: true },
      },
      messagesByConvo: { [conv]: messages },
      messageCursorByConvo: { [conv]: 0 },
    })
    const page: MessagesPage = {
      messages: [message('m1', '2026-01-01T00:00:00Z'), message('m2', '2026-01-01T00:00:01Z')],
    }
    const patch = mergeActivePagePatch(state, conv, page, focus)
    expect(patch.messageCacheByConvo?.[conv]?.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  test('an edit to an existing message still produces a patch', () => {
    const messages = [message('m1', '2026-01-01T00:00:00Z')]
    const state = appStateWith({
      messageCacheByConvo: {
        [conv]: { messages, loadingOlder: false, fullyLoaded: true },
      },
      messagesByConvo: { [conv]: messages },
      messageCursorByConvo: { [conv]: 0 },
    })
    const page: MessagesPage = {
      messages: [
        message('m1', '2026-01-01T00:00:00Z', {
          lastModifiedDateTime: '2026-01-01T00:05:00Z',
          body: { contentType: 'text', content: 'edited' },
        }),
      ],
    }
    const patch = mergeActivePagePatch(state, conv, page, focus)
    expect(patch.messageCacheByConvo?.[conv]?.messages[0]?.body.content).toBe('edited')
  })

  test('a new reaction on an otherwise identical message produces a patch', () => {
    const messages = [message('m1', '2026-01-01T00:00:00Z')]
    const state = appStateWith({
      messageCacheByConvo: {
        [conv]: { messages, loadingOlder: false, fullyLoaded: true },
      },
      messagesByConvo: { [conv]: messages },
      messageCursorByConvo: { [conv]: 0 },
    })
    const page: MessagesPage = {
      messages: [message('m1', '2026-01-01T00:00:00Z', { reactions: [{ reactionType: 'like' }] })],
    }
    const patch = mergeActivePagePatch(state, conv, page, focus)
    expect(patch.messageCacheByConvo?.[conv]?.messages[0]?.reactions?.[0]?.reactionType).toBe(
      'like',
    )
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
