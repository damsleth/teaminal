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

  test('regression: scrolling up from the bottom keeps the window fixed until the cursor hits the top edge', () => {
    // The reported bug: after scrolling to the bottom, moving back up
    // dragged the window along with the cursor, pinning the cursor to
    // the bottom row on every keypress. The window must stay put while
    // the cursor moves within it, and only scroll once the cursor is
    // the topmost visible row.
    const heights = uniformHeights(20)
    const budget = 6
    let prev = 0
    for (let c = 0; c < heights.length; c++) {
      prev = computeChatListViewport(heights, c, budget, prev).viewStart
    }
    expect(prev).toBe(14)

    // Walk back up: while the cursor is inside [14, 20) the window is
    // unchanged...
    for (let c = 19; c >= 14; c--) {
      const v = computeChatListViewport(heights, c, budget, prev)
      expect(v).toEqual({ viewStart: 14, visibleEnd: 20 })
      prev = v.viewStart
    }
    // ...and past the top edge it scrolls minimally, cursor staying on
    // the first visible row.
    for (let c = 13; c >= 0; c--) {
      const v = computeChatListViewport(heights, c, budget, prev)
      expect(v.viewStart).toBe(c)
      expect(v.visibleEnd).toBe(c + budget)
      prev = v.viewStart
    }
  })

  test('cursor jumping above the window lands on the top row, not the bottom', () => {
    const heights = uniformHeights(20)
    // Window at [10, 16), cursor jumps to 3 (e.g. filter or gg-style jump).
    const v = computeChatListViewport(heights, 3, 6, 10)
    expect(v).toEqual({ viewStart: 3, visibleEnd: 9 })
  })

  test('budget left over after hitting the end of the list back-fills older rows', () => {
    // Window anchored near the end, terminal grew: forward fill runs out
    // of rows, so the extra budget pulls in rows above instead of
    // rendering a short list.
    const heights = uniformHeights(10)
    const v = computeChatListViewport(heights, 8, 6, 7)
    expect(v).toEqual({ viewStart: 4, visibleEnd: 10 })
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

  describe('scrolloff', () => {
    test('scrolling down keeps context rows visible below the cursor', () => {
      // budget=6, off=2: the window scrolls once the cursor reaches the
      // 4th visible row (index start+3), keeping 2 rows below it.
      const heights = uniformHeights(20)
      let prev = 0
      for (let c = 0; c < heights.length; c++) {
        const v = computeChatListViewport(heights, c, 6, prev, 2)
        expect(c).toBeGreaterThanOrEqual(v.viewStart)
        expect(c).toBeLessThan(v.visibleEnd)
        // 2 rows of context below the cursor, except near the list end.
        expect(v.visibleEnd).toBeGreaterThanOrEqual(Math.min(c + 3, heights.length))
        prev = v.viewStart
      }
      // Cursor on the last row: window ends at the list end.
      expect(prev).toBe(14)
    })

    test('scrolling up keeps context rows visible above the cursor', () => {
      const heights = uniformHeights(20)
      // Start from the bottom.
      let prev = computeChatListViewport(heights, 19, 6, 14, 2).viewStart
      for (let c = 19; c >= 0; c--) {
        const v = computeChatListViewport(heights, c, 6, prev, 2)
        expect(c).toBeGreaterThanOrEqual(v.viewStart)
        expect(c).toBeLessThan(v.visibleEnd)
        // 2 rows of context above the cursor, except near the list top.
        expect(v.viewStart).toBeLessThanOrEqual(Math.max(c - 2, 0))
        prev = v.viewStart
      }
      expect(prev).toBe(0)
    })

    test('window stays put while the cursor moves between the margins', () => {
      const heights = uniformHeights(20)
      // Window [5, 11), off=2: cursor can move between rows 7 and 8
      // without the window budging.
      for (const c of [7, 8]) {
        const v = computeChatListViewport(heights, c, 6, 5, 2)
        expect(v).toEqual({ viewStart: 5, visibleEnd: 11 })
      }
      // Row 9 is inside the bottom margin: the window scrolls down one.
      expect(computeChatListViewport(heights, 9, 6, 5, 2)).toEqual({ viewStart: 6, visibleEnd: 12 })
      // Row 6 is inside the top margin: the window scrolls up one.
      expect(computeChatListViewport(heights, 6, 6, 5, 2)).toEqual({ viewStart: 4, visibleEnd: 10 })
    })

    test('margin shrinks at the list ends instead of pinning the cursor away from them', () => {
      const heights = uniformHeights(10)
      // Cursor on the first row: window starts at 0.
      expect(computeChatListViewport(heights, 0, 4, 5, 2)).toEqual({ viewStart: 0, visibleEnd: 4 })
      // Cursor on the last row: window ends at the list end.
      expect(computeChatListViewport(heights, 9, 4, 0, 2)).toEqual({ viewStart: 6, visibleEnd: 10 })
    })

    test('tiny budget degrades to cursor-only without violating the invariant', () => {
      const heights = uniformHeights(10)
      for (let c = 0; c < heights.length; c++) {
        const v = computeChatListViewport(heights, c, 1, Math.max(0, c - 1), 2)
        expect(c).toBeGreaterThanOrEqual(v.viewStart)
        expect(c).toBeLessThan(v.visibleEnd)
      }
    })

    test('wrapped rows (heights > 1) count rows, not lines, for the margin', () => {
      // Rows of height 2, budget 8 -> 4 rows visible, off=1.
      const heights = uniformHeights(10, 2)
      // Cursor at 5 entering the bottom margin of window [2, 6): scrolls
      // so one context row stays below.
      const v = computeChatListViewport(heights, 5, 8, 2, 1)
      expect(v.visibleEnd).toBeGreaterThanOrEqual(7)
      expect(v.viewStart).toBeLessThanOrEqual(5)
    })
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
