import { describe, expect, test } from 'bun:test'
import { chromeRowsForChatList, computeChatListViewport } from './chatListViewport'

function uniformHeights(n: number, h = 1): number[] {
  return Array.from({ length: n }, () => h)
}

describe('computeChatListViewport', () => {
  test('empty list returns zero window', () => {
    expect(computeChatListViewport([], 0, 10, 0)).toEqual({ viewStart: 0, visibleEnd: 0 })
  })

  test('all rows fit when budget exceeds total height', () => {
    const heights = uniformHeights(5)
    expect(computeChatListViewport(heights, 0, 10, 0)).toEqual({ viewStart: 0, visibleEnd: 5 })
  })

  test('cursor at end scrolls window so cursor row is rendered', () => {
    const heights = uniformHeights(10)
    const { viewStart, visibleEnd } = computeChatListViewport(heights, 9, 4, 0)
    expect(viewStart).toBeLessThanOrEqual(9)
    expect(visibleEnd).toBeGreaterThan(9)
    expect(visibleEnd - viewStart).toBe(4)
  })

  test('moving cursor down past the bottom of the previous viewport advances start', () => {
    // Budget=4. Initial viewport at 0..4, cursor at 3.
    const heights = uniformHeights(10)
    const first = computeChatListViewport(heights, 3, 4, 0)
    expect(first).toEqual({ viewStart: 0, visibleEnd: 4 })

    // Cursor moves to 4 - off the bottom of the previous slice.
    const second = computeChatListViewport(heights, 4, 4, first.viewStart)
    expect(second.viewStart).toBe(1)
    expect(second.visibleEnd).toBe(5)
    expect(second.viewStart).toBeLessThanOrEqual(4)
    expect(second.visibleEnd).toBeGreaterThan(4)
  })

  test('regression: scrolling down keeps the cursor row inside the visible slice', () => {
    // Reproduce the reported bug shape: tail panels eat most of the
    // terminal so rowsVisible is small (e.g. 3). With the old logic the
    // viewport could end at the cursor row's index, leaving the cursor
    // outside [viewStart, visibleEnd). Walk a small budget down a longer
    // list and assert the cursor is always inside.
    const heights = uniformHeights(15)
    const budget = 3
    let previousStart = 0
    for (let cursor = 0; cursor < heights.length; cursor++) {
      const { viewStart, visibleEnd } = computeChatListViewport(
        heights,
        cursor,
        budget,
        previousStart,
      )
      expect(cursor).toBeGreaterThanOrEqual(viewStart)
      expect(cursor).toBeLessThan(visibleEnd)
      previousStart = viewStart
    }
  })

  test('moving cursor up before the previous start scrolls up', () => {
    const heights = uniformHeights(10)
    // Cursor was at 7 with start=5
    const before = computeChatListViewport(heights, 7, 3, 5)
    expect(before).toEqual({ viewStart: 5, visibleEnd: 8 })
    // Now cursor jumps up to 2
    const after = computeChatListViewport(heights, 2, 3, before.viewStart)
    expect(after.viewStart).toBeLessThanOrEqual(2)
    expect(after.visibleEnd).toBeGreaterThan(2)
  })

  test('sticky scroll keeps previousStart when cursor stays inside budget', () => {
    const heights = uniformHeights(10)
    // Start at 0, cursor at 2. budget=5. Window 0..5.
    const first = computeChatListViewport(heights, 2, 5, 0)
    expect(first).toEqual({ viewStart: 0, visibleEnd: 5 })
    // Cursor moves to 4 - still fits inside 0..5.
    const second = computeChatListViewport(heights, 4, 5, first.viewStart)
    expect(second.viewStart).toBe(0)
    expect(second.visibleEnd).toBe(5)
  })

  test('handles wrapped rows (heights > 1) without overshooting budget', () => {
    // Rows 0..4 each take 2 visual lines. budget=4 -> at most 2 rows fit.
    const heights = uniformHeights(5, 2)
    const { viewStart, visibleEnd } = computeChatListViewport(heights, 4, 4, 0)
    expect(visibleEnd - viewStart).toBe(2)
    expect(viewStart).toBe(3)
    expect(visibleEnd).toBe(5)
  })

  test('clamps cursor index outside the heights range', () => {
    const heights = uniformHeights(3)
    expect(computeChatListViewport(heights, -1, 10, 0)).toEqual({ viewStart: 0, visibleEnd: 3 })
    expect(computeChatListViewport(heights, 99, 10, 0)).toEqual({ viewStart: 0, visibleEnd: 3 })
  })
})

describe('chromeRowsForChatList', () => {
  test('baseline chrome (no tails, no filter)', () => {
    expect(chromeRowsForChatList({ hasFilterBanner: false, anyTailEnabled: false })).toBe(9)
  })

  test('any tail panel adds 9 rows', () => {
    expect(chromeRowsForChatList({ hasFilterBanner: false, anyTailEnabled: true })).toBe(18)
  })

  test('filter banner adds 1 row', () => {
    expect(chromeRowsForChatList({ hasFilterBanner: true, anyTailEnabled: false })).toBe(10)
  })

  test('regression: tail panels are counted so the chat list does not over-budget', () => {
    // The reported bug: with tail panels on, the old hardcoded chrome
    // estimate (8) thought the chat list had ~16 rows of budget on a
    // 24-row terminal, while in reality it had 24 - 18 = 6. The cursor
    // row got pushed below the box border and clipped.
    const baseline = chromeRowsForChatList({ hasFilterBanner: false, anyTailEnabled: false })
    const withTails = chromeRowsForChatList({ hasFilterBanner: false, anyTailEnabled: true })
    expect(withTails - baseline).toBeGreaterThanOrEqual(9)
  })
})
