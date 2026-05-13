// Pure viewport math for the chat list.
//
// Given the visual height of each row, the cursor row index, the
// visible-row budget, and the previous viewport origin, compute the
// slice of rows to render.
//
// Invariant: the cursor row is always inside [viewStart, visibleEnd).
// If the cursor would be clipped, the window advances so the cursor
// stays on screen - this is what `j` / `k` users expect.

export type Viewport = { viewStart: number; visibleEnd: number }

export function computeChatListViewport(
  heights: number[],
  cursorRowIdx: number,
  rowsVisible: number,
  previousStart: number,
): Viewport {
  if (heights.length === 0) return { viewStart: 0, visibleEnd: 0 }
  const budget = Math.max(1, rowsVisible)
  const cur =
    cursorRowIdx < 0 ? 0 : cursorRowIdx >= heights.length ? heights.length - 1 : cursorRowIdx
  let start = cur
  let end = cur + 1
  let consumed = heights[cur] ?? 1

  // Sticky scroll: prefer to keep `previousStart` if the cursor is
  // already inside it (and the cumulative budget still fits).
  if (previousStart >= 0 && previousStart <= cur && previousStart < heights.length) {
    let trial = consumed
    let trialStart = cur
    while (trialStart > previousStart) {
      const h = heights[trialStart - 1] ?? 1
      if (trial + h > budget) break
      trialStart--
      trial += h
    }
    if (trialStart === previousStart) {
      start = previousStart
      consumed = trial
    }
  }

  // Backward fill: include older rows while budget allows.
  while (start > 0) {
    const h = heights[start - 1] ?? 1
    if (consumed + h > budget) break
    start--
    consumed += h
  }

  // Forward fill: top off the budget with newer rows.
  while (end < heights.length) {
    const h = heights[end] ?? 1
    if (consumed + h > budget) break
    consumed += h
    end++
  }

  return { viewStart: start, visibleEnd: end }
}

// Rows of "chrome" outside the chat list content area. Used to convert
// terminal height into the chat list's visible-row budget.
//
// Layout under App.tsx (top to bottom):
//   - HeaderBar box (border + 1 content)        = 3
//   - ChatList own border (round)               = 2
//   - TailPanels box when any enabled           = 9
//       (border 2 + 1 header label + 6 content)
//   - Composer box (border + ~1 content)        = 3
//   - StatusBar                                 = 1
//   - Filter banner inside ChatList when shown  = 1
//
// Composer can grow taller while the user types, but the active focus
// is then in the composer, not the list, so the budget being slightly
// generous in that case doesn't cause the visible-cursor-row bug this
// helper exists to prevent.
export function chromeRowsForChatList(args: {
  hasFilterBanner: boolean
  anyTailEnabled: boolean
}): number {
  let rows = 3 + 2 + 3 + 1
  if (args.anyTailEnabled) rows += 9
  if (args.hasFilterBanner) rows += 1
  return rows
}
