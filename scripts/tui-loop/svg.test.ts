import { describe, expect, test } from 'bun:test'
import { renderGridSvg } from './svg'
import type { Cell } from './terminal'

function cell(char: string, style: Partial<Cell> = {}): Cell {
  return { char, fg: null, bg: null, bold: false, inverse: false, ...style }
}

describe('renderGridSvg', () => {
  test('renders a background rect for a blank highlighted run', () => {
    const grid = [[cell(' ', { bg: '#3971ed' }), cell(' ', { bg: '#3971ed' })]]
    const svg = renderGridSvg(grid, 'selection')

    // The background fill survives even though the run is whitespace-only...
    expect(svg).toContain('fill="#3971ed"')
    expect(svg).toContain('<rect')
    // ...and no glyph text is drawn for blank cells.
    expect(svg).not.toContain('<text x="10" y="28"')
  })

  test('swaps fg/bg for reverse video cells', () => {
    const grid = [[cell('A', { fg: '#cc3333', inverse: true })]]
    const svg = renderGridSvg(grid, 'inverse')

    // fg (#cc3333) becomes the background; the page default becomes the glyph color.
    expect(svg).toContain('fill="#cc3333"') // the rect
    expect(svg).toContain('fill="#0b0f14"') // the glyph, swapped to the page bg
  })

  test('escapes xml-significant characters', () => {
    const grid = [[cell('<'), cell('&')]]
    const svg = renderGridSvg(grid, 'escape & <test>')

    expect(svg).toContain('&lt;')
    expect(svg).toContain('&amp;')
    expect(svg).toContain('escape &amp; &lt;test&gt;')
  })
})
