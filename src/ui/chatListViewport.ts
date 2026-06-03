// Pure viewport math for the chat list.
//
// Given the visual height of each row, the cursor row index, the
// visible-row budget, and the previous viewport origin, compute the
// slice of rows to render.
//
// Invariant: the cursor row is always inside [viewStart, visibleEnd).
// The window only moves when the cursor would leave it: moving past the
// bottom scrolls down minimally (cursor lands on the last visible row),
// moving above the top scrolls up minimally (cursor lands on the first
// visible row). While the cursor is inside the window, the window stays
// put and the cursor moves within it - this is what `j` / `k` users
// expect.
//
// `scrolloff` (vim-style) keeps up to that many context rows visible
// beyond the cursor: scrolling down keeps `scrolloff` rows below it,
// scrolling up keeps `scrolloff` rows above it. The margin shrinks at
// the list ends and on tiny budgets - the cursor row itself always
// wins. Default 0 preserves the edge-riding behavior.

export type Viewport = { viewStart: number; visibleEnd: number }

export function computeChatListViewport(
  heights: number[],
  cursorRowIdx: number,
  rowsVisible: number,
  previousStart: number,
  scrolloff = 0,
): Viewport {
  if (heights.length === 0) return { viewStart: 0, visibleEnd: 0 }
  const budget = Math.max(1, rowsVisible)
  const cur =
    cursorRowIdx < 0 ? 0 : cursorRowIdx >= heights.length ? heights.length - 1 : cursorRowIdx
  const off = Math.max(0, scrolloff)
  const hasPrev = previousStart >= 0 && previousStart < heights.length

  let start: number
  let end: number
  let consumed: number

  // Topmost row the cursor wants visible above it (list top clamps it).
  const wantTop = Math.max(0, cur - off)

  if (hasPrev && wantTop < previousStart) {
    // Cursor moved above the window or into its top margin: scroll up
    // minimally so `off` rows of context sit above the cursor. Forward
    // fill below does the rest.
    start = wantTop
    end = cur + 1
    consumed = 0
    for (let i = start; i <= cur; i++) consumed += heights[i] ?? 1
    // Tiny budget: shed above-context rows until the cursor fits.
    while (start < cur && consumed > budget) {
      consumed -= heights[start] ?? 1
      start++
    }
  } else {
    // Anchor block: the cursor plus up to `off` context rows below it,
    // trimmed until it fits the budget.
    let anchorEnd = Math.min(cur + off, heights.length - 1)
    consumed = 0
    for (let i = cur; i <= anchorEnd; i++) consumed += heights[i] ?? 1
    while (anchorEnd > cur && consumed > budget) {
      consumed -= heights[anchorEnd] ?? 1
      anchorEnd--
    }
    start = cur
    end = anchorEnd + 1

    // Sticky scroll: keep `previousStart` if the anchor block still fits
    // inside the window it implies (the cumulative budget from
    // previousStart through the anchor block fits). The window stays
    // fixed; the cursor moves within.
    let stuck = false
    if (hasPrev && previousStart <= cur) {
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
        stuck = true
      }
    }

    // Anchor block moved below the window (or no usable previous start):
    // scroll down minimally so the anchor block ends on the last visible
    // row.
    if (!stuck) {
      while (start > 0) {
        const h = heights[start - 1] ?? 1
        if (consumed + h > budget) break
        start--
        consumed += h
      }
    }
  }

  // Forward fill: top off the budget with newer rows.
  while (end < heights.length) {
    const h = heights[end] ?? 1
    if (consumed + h > budget) break
    consumed += h
    end++
  }

  // Backward top-up: only spends budget left over after forward fill hit
  // the end of the list (short lists, terminal grew) - it never shifts a
  // budget-full window.
  while (start > 0) {
    const h = heights[start - 1] ?? 1
    if (consumed + h > budget) break
    start--
    consumed += h
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
