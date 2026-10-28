import { expect, test } from 'bun:test'
import { mergeSettings } from '../config'
import { clampToLines } from './ChatList'

test('clamps a word-wrapped preview to N lines, ellipsis on the last kept one', () => {
  const text = 'Birgit: Hei Ola. Håper alt står bra til:) Jeg har noen pund'
  const lines = clampToLines(text, 24, 2).split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[1]!.endsWith('…')).toBe(true)
  for (const l of lines) expect(l.length).toBeLessThanOrEqual(24)
})

test('a preview that fits keeps its own line count', () => {
  expect(clampToLines('Kari: awesome', 24, 3)).toBe('Kari: awesome')
})

test('legacy showMessagePreviews:false maps to 0 preview lines unless the new key is set', () => {
  expect(mergeSettings({ showMessagePreviews: false }, []).chatListPreviewLines).toBe(0)
  expect(mergeSettings({ showMessagePreviews: true }, []).chatListPreviewLines).toBe(1)
  expect(
    mergeSettings({ showMessagePreviews: false, chatListPreviewLines: 2 }, []).chatListPreviewLines,
  ).toBe(2)
})
