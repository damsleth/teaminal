import { describe, expect, test } from 'bun:test'
import {
  cursorLineCol,
  emptyBuffer,
  reduce,
  splitLines,
  type ComposerBuffer,
} from './composerReducer'

const b = (text: string, cursor = text.length): ComposerBuffer => ({ text, cursor })

describe('composer reducer', () => {
  describe('insert', () => {
    test('appends at end-of-buffer', () => {
      expect(reduce(emptyBuffer, { kind: 'insert', chars: 'abc' })).toEqual({
        text: 'abc',
        cursor: 3,
      })
    })
    test('inserts mid-buffer and advances the cursor', () => {
      expect(reduce(b('abdef', 2), { kind: 'insert', chars: 'c' })).toEqual({
        text: 'abcdef',
        cursor: 3,
      })
    })
    test('empty insert is a no-op', () => {
      const s = b('hi', 1)
      expect(reduce(s, { kind: 'insert', chars: '' })).toBe(s)
    })
    test('multi-char insert (paste shape)', () => {
      expect(reduce(emptyBuffer, { kind: 'insert', chars: 'a\nb\nc' })).toEqual({
        text: 'a\nb\nc',
        cursor: 5,
      })
    })
  })

  describe('backspace and delete', () => {
    test('backspace at start is a no-op', () => {
      const s = b('abc', 0)
      expect(reduce(s, { kind: 'backspace' })).toBe(s)
    })
    test('backspace removes char before cursor', () => {
      expect(reduce(b('abc', 2), { kind: 'backspace' })).toEqual({ text: 'ac', cursor: 1 })
    })
    test('delete-forward at end is a no-op', () => {
      const s = b('abc', 3)
      expect(reduce(s, { kind: 'delete-forward' })).toBe(s)
    })
    test('delete-forward removes char at cursor', () => {
      expect(reduce(b('abc', 1), { kind: 'delete-forward' })).toEqual({ text: 'ac', cursor: 1 })
    })
  })

  describe('word deletion', () => {
    test('delete-prev-word eats whitespace + last word', () => {
      expect(reduce(b('hello world ', 12), { kind: 'delete-prev-word' })).toEqual({
        text: 'hello ',
        cursor: 6,
      })
    })
    test('delete-prev-word at start is a no-op', () => {
      const s = b('hello', 0)
      expect(reduce(s, { kind: 'delete-prev-word' })).toBe(s)
    })
  })

  describe('line deletion', () => {
    test('delete-to-line-start clears the current line up to cursor', () => {
      expect(reduce(b('first\nsecond line', 11), { kind: 'delete-to-line-start' })).toEqual({
        text: 'first\nd line',
        cursor: 6,
      })
    })
    test('delete-to-line-end clears from cursor to newline', () => {
      expect(reduce(b('first\nsecond', 8), { kind: 'delete-to-line-end' })).toEqual({
        text: 'first\nse',
        cursor: 8,
      })
    })
    test('delete-to-line-end at line end joins with the next line', () => {
      expect(reduce(b('a\nb', 1), { kind: 'delete-to-line-end' })).toEqual({
        text: 'ab',
        cursor: 1,
      })
    })
  })

  describe('cursor motion', () => {
    test('cursor-left clamps at 0', () => {
      expect(reduce(b('hi', 0), { kind: 'cursor-left' })).toEqual({ text: 'hi', cursor: 0 })
      expect(reduce(b('hi', 2), { kind: 'cursor-left' })).toEqual({ text: 'hi', cursor: 1 })
    })
    test('cursor-right clamps at length', () => {
      expect(reduce(b('hi', 2), { kind: 'cursor-right' })).toEqual({ text: 'hi', cursor: 2 })
      expect(reduce(b('hi', 0), { kind: 'cursor-right' })).toEqual({ text: 'hi', cursor: 1 })
    })
    test('prev/next-word jumps over runs', () => {
      expect(reduce(b('foo bar baz', 11), { kind: 'cursor-prev-word' }).cursor).toBe(8)
      expect(reduce(b('foo bar baz', 0), { kind: 'cursor-next-word' }).cursor).toBe(3)
    })
    test('line-start / line-end on the second line', () => {
      const s = b('first\nsecond', 9)
      expect(reduce(s, { kind: 'cursor-line-start' }).cursor).toBe(6)
      expect(reduce(s, { kind: 'cursor-line-end' }).cursor).toBe(12)
    })
    test('buffer-start / buffer-end', () => {
      expect(reduce(b('xxx', 1), { kind: 'cursor-buffer-start' }).cursor).toBe(0)
      expect(reduce(b('xxx', 1), { kind: 'cursor-buffer-end' }).cursor).toBe(3)
    })
  })

  describe('set-text', () => {
    test('replaces text and clamps cursor to length', () => {
      expect(reduce(b('hello', 3), { kind: 'set-text', text: 'hi' })).toEqual({
        text: 'hi',
        cursor: 2,
      })
    })
    test('explicit cursor honored when in range', () => {
      expect(reduce(emptyBuffer, { kind: 'set-text', text: 'hello', cursor: 3 })).toEqual({
        text: 'hello',
        cursor: 3,
      })
    })
  })

  describe('helpers', () => {
    test('splitLines', () => {
      expect(splitLines('a\nb\nc')).toEqual(['a', 'b', 'c'])
      expect(splitLines('')).toEqual([''])
    })
    test('cursorLineCol', () => {
      expect(cursorLineCol('first\nsecond', 9)).toEqual({ line: 1, col: 3 })
      expect(cursorLineCol('hello', 0)).toEqual({ line: 0, col: 0 })
    })
  })
})
