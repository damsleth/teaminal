import { expect, test } from 'bun:test'
import { cursorRowCol, wrapComposer } from './composerWrap'

test('breaks after the last space that fits, keeping offsets contiguous', () => {
  const rows = wrapComposer('hello brave new world', 10)
  expect(rows.map((r) => r.text)).toEqual(['hello ', 'brave new ', 'world'])
  expect(rows.map((r) => r.start)).toEqual([0, 6, 16])
})

test('hard-breaks a word longer than the width', () => {
  expect(wrapComposer('abcdefghij', 4).map((r) => r.text)).toEqual(['abcd', 'efgh', 'ij'])
})

test('explicit newlines start new rows, empty lines included', () => {
  const rows = wrapComposer('a\n\nb', 10)
  expect(rows.map((r) => [r.text, r.start, r.lineStart])).toEqual([
    ['a', 0, true],
    ['', 2, true],
    ['b', 3, true],
  ])
})

test('cursor at a soft-wrap boundary sits at the start of the next row', () => {
  const rows = wrapComposer('hello brave', 8)
  expect(cursorRowCol(rows, 6)).toEqual({ row: 1, col: 0 })
  expect(cursorRowCol(rows, 11)).toEqual({ row: 1, col: 5 })
  expect(cursorRowCol(rows, 2)).toEqual({ row: 0, col: 2 })
})
