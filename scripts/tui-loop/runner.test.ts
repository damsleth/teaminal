import { describe, expect, test } from 'bun:test'
import { splitMarkedStream } from './runner'

describe('splitMarkedStream', () => {
  test('splits output on markers and carries preceding bytes', () => {
    const segments = splitMarkedStream('aaa@@TUI_LOOP:0@@bbb@@TUI_LOOP:1@@ccc')

    expect(segments).toEqual([
      { text: 'aaa', markerIndex: 0 },
      { text: 'bbb', markerIndex: 1 },
      { text: 'ccc', markerIndex: null },
    ])
  })

  test('returns a single trailing segment when there are no markers', () => {
    expect(splitMarkedStream('plain output')).toEqual([
      { text: 'plain output', markerIndex: null },
    ])
  })

  test('handles a marker at the very end with an empty trailing segment', () => {
    expect(splitMarkedStream('done@@TUI_LOOP:2@@')).toEqual([
      { text: 'done', markerIndex: 2 },
      { text: '', markerIndex: null },
    ])
  })
})
