import { describe, expect, test } from 'bun:test'
import type { ChatMessage } from '../types'
import {
  channelRoots,
  groupChannelThreads,
  isChannelRoot,
  replyCountForRoot,
} from './channelThreads'

function msg(id: string, replyToId?: string): ChatMessage {
  return {
    id,
    createdDateTime: '2026-06-01T00:00:00.000Z',
    body: { contentType: 'text', content: id },
    ...(replyToId ? { replyToId, rootMessageId: replyToId } : { rootMessageId: id }),
  }
}

// Stream order = chronological, as the chatsvc reader emits it: a root
// followed by its replies, interleaved across threads.
const stream: ChatMessage[] = [
  msg('r1'),
  msg('a', 'r1'),
  msg('b', 'r1'),
  msg('r2'),
  msg('c', 'r2'),
]

describe('isChannelRoot / channelRoots', () => {
  test('a message with no replyToId is a root', () => {
    expect(isChannelRoot(msg('r1'))).toBe(true)
    expect(isChannelRoot(msg('a', 'r1'))).toBe(false)
  })

  test('channelRoots keeps only roots, in stream order', () => {
    expect(channelRoots(stream).map((m) => m.id)).toEqual(['r1', 'r2'])
  })
})

describe('groupChannelThreads', () => {
  test('splits the flat stream into roots + repliesByRoot', () => {
    const { roots, repliesByRoot } = groupChannelThreads(stream)
    expect(roots.map((m) => m.id)).toEqual(['r1', 'r2'])
    expect(repliesByRoot['r1']?.map((m) => m.id)).toEqual(['a', 'b'])
    expect(repliesByRoot['r2']?.map((m) => m.id)).toEqual(['c'])
  })

  test('replyCountForRoot counts a root’s replies (0 when none/unknown)', () => {
    const threads = groupChannelThreads(stream)
    expect(replyCountForRoot(threads, 'r1')).toBe(2)
    expect(replyCountForRoot(threads, 'r2')).toBe(1)
    expect(replyCountForRoot(threads, 'missing')).toBe(0)
  })

  test('clusters orphan replies whose root is outside the loaded window', () => {
    // Only the reply is loaded; its root scrolled off the top. It still
    // groups under the rootId so the thread is reconstructable later.
    const { roots, repliesByRoot } = groupChannelThreads([msg('x', 'older-root')])
    expect(roots).toHaveLength(0)
    expect(repliesByRoot['older-root']?.map((m) => m.id)).toEqual(['x'])
  })
})
