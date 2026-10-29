import { expect, test } from 'bun:test'
import { mergeSettings } from '../config'
import type { Chat } from '../types'
import { clampToLines, previewLineForChat } from './ChatList'

test('preview prefix: "You" for your own, none for the other side of a 1:1, the name in groups', () => {
  const chat = (chatType: string, id: string, displayName: string) =>
    ({
      id: 'c',
      chatType,
      lastMessagePreview: {
        body: { contentType: 'text', content: 'hi' },
        from: { user: { id, displayName } },
      },
    }) as unknown as Chat
  expect(previewLineForChat(chat('oneOnOne', 'me', 'Carl'), 40, 1, 'me')).toBe('You: hi')
  expect(previewLineForChat(chat('group', 'me', 'Carl'), 40, 1, 'me')).toBe('You: hi')
  expect(previewLineForChat(chat('oneOnOne', 'ada', 'Ada'), 40, 1, 'me')).toBe('hi')
  expect(previewLineForChat(chat('group', 'ada', 'Ada'), 40, 1, 'me')).toBe('Ada: hi')
})

test('clamps a word-wrapped preview to N lines, ellipsis on the last kept one', () => {
  const text = 'Vibeke: Hei Kim. Håper alt står bra til:) Jeg har noen pund'
  const lines = clampToLines(text, 24, 2).split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[1]!.endsWith('…')).toBe(true)
  for (const l of lines) expect(l.length).toBeLessThanOrEqual(24)
})

test('a preview that fits keeps its own line count', () => {
  expect(clampToLines('Carl: awesome', 24, 3)).toBe('Carl: awesome')
})

test('legacy showMessagePreviews:false maps to 0 preview lines unless the new key is set', () => {
  expect(mergeSettings({ showMessagePreviews: false }, []).chatListPreviewLines).toBe(0)
  expect(mergeSettings({ showMessagePreviews: true }, []).chatListPreviewLines).toBe(1)
  expect(
    mergeSettings({ showMessagePreviews: false, chatListPreviewLines: 2 }, []).chatListPreviewLines,
  ).toBe(2)
})
