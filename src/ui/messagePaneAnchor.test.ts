import { describe, expect, test } from 'bun:test'
import { bottomChromeRows } from './MessagePane'
import { TAIL_PANEL_ROWS } from './TailPanels'

// Inline images are painted by moving the cursor up from the bottom of the
// frame, so this total IS the image anchor. Undercount it by k and every
// image paints k rows too low — straight over the following messages.
//
// Numbers below were read off a real 45-row frame: below the last message row
// sit the pane's bottom border (1), the tail strip (9), the composer box (3),
// and the status bar (1).
describe('bottomChromeRows', () => {
  test('matches the measured frame with tails on', () => {
    expect(bottomChromeRows({ statusBarHidden: false, composerRows: 3, tailRows: TAIL_PANEL_ROWS }))
      // 1 pane border + 9 tail strip + 3 composer + 1 status bar
      .toBe(14)
  })

  test('drops the tail strip when no tail is enabled', () => {
    expect(bottomChromeRows({ statusBarHidden: false, composerRows: 3, tailRows: 0 })).toBe(5)
  })

  test('tracks a taller composer', () => {
    expect(bottomChromeRows({ statusBarHidden: false, composerRows: 10, tailRows: 0 })).toBe(12)
  })

  test('frees the status bar row when it is hidden or moved to the top', () => {
    expect(bottomChromeRows({ statusBarHidden: true, composerRows: 3, tailRows: 0 })).toBe(4)
  })

  test('the tail strip is 9 rows: box border, heading, and six content rows', () => {
    expect(TAIL_PANEL_ROWS).toBe(9)
  })
})
