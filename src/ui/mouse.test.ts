import { describe, expect, test } from 'bun:test'
import { createMouseParser, type MouseEvent } from './mouse'

const sgr = (b: number, x: number, y: number, final = 'M') => `\x1b[<${b};${x};${y}${final}`
const parse = (...chunks: (string | Buffer)[]) => {
  const p = createMouseParser()
  return chunks.flatMap((c) => p.push(c))
}
const ev = (over: Partial<MouseEvent>): MouseEvent => ({
  kind: 'down',
  button: 'left',
  x: 0,
  y: 0,
  shift: false,
  meta: false,
  ctrl: false,
  ...over,
})

describe('createMouseParser', () => {
  test('press and release per button, 0-based cells', () => {
    expect(parse(sgr(0, 10, 5))).toEqual([ev({ x: 9, y: 4 })])
    expect(parse(sgr(0, 10, 5, 'm'))).toEqual([ev({ kind: 'up', x: 9, y: 4 })])
    expect(parse(sgr(1, 1, 1))).toEqual([ev({ button: 'middle' })])
    expect(parse(sgr(2, 1, 1, 'm'))).toEqual([ev({ kind: 'up', button: 'right' })])
    // Button 3 (no button) is never an action.
    expect(parse(sgr(3, 1, 1))).toEqual([])
  })

  test('vertical wheel only; horizontal and extended buttons are ignored', () => {
    expect(parse(sgr(64, 3, 4))).toEqual([
      ev({ kind: 'wheel', button: null, wheel: -1, x: 2, y: 3 }),
    ])
    expect(parse(sgr(65, 3, 4))).toEqual([
      ev({ kind: 'wheel', button: null, wheel: 1, x: 2, y: 3 }),
    ])
    expect(parse(sgr(65, 3, 4, 'm'))).toEqual([])
    expect(parse(sgr(66, 3, 4), sgr(67, 3, 4), sgr(128, 3, 4), sgr(129, 3, 4))).toEqual([])
  })

  test('modifier bits', () => {
    expect(parse(sgr(4, 1, 1))).toEqual([ev({ shift: true })])
    expect(parse(sgr(8, 1, 1))).toEqual([ev({ meta: true })])
    expect(parse(sgr(16, 1, 1))).toEqual([ev({ ctrl: true })])
    expect(parse(sgr(28, 1, 1))).toEqual([ev({ shift: true, meta: true, ctrl: true })])
    // Modifiers are masked before the wheel is decoded.
    expect(parse(sgr(64 + 16, 1, 1))).toEqual([
      ev({ kind: 'wheel', button: null, wheel: -1, ctrl: true }),
    ])
  })

  test('motion is ignored, with or without a button', () => {
    expect(parse(sgr(32, 5, 5), sgr(33, 5, 5), sgr(35, 5, 5), sgr(32 + 4, 5, 5))).toEqual([])
  })

  test('several reports in one chunk', () => {
    expect(parse(sgr(0, 1, 2) + sgr(0, 1, 2, 'm') + sgr(65, 3, 4))).toEqual([
      ev({ y: 1 }),
      ev({ kind: 'up', y: 1 }),
      ev({ kind: 'wheel', button: null, wheel: 1, x: 2, y: 3 }),
    ])
  })

  test('one report split over two and three chunks', () => {
    expect(parse('\x1b[<0;1', '0;5M')).toEqual([ev({ x: 9, y: 4 })])
    expect(parse('\x1b', '[<0;10', ';5M')).toEqual([ev({ x: 9, y: 4 })])
    expect(parse('a\x1b[', '<', '0;10;5Mb')).toEqual([ev({ x: 9, y: 4 })])
  })

  test('reports between keys and focus reports', () => {
    expect(parse(`j\x1b[I${sgr(0, 2, 2)}k\x1b[O${sgr(0, 2, 2, 'm')}\r`)).toEqual([
      ev({ x: 1, y: 1 }),
      ev({ kind: 'up', x: 1, y: 1 }),
    ])
  })

  test('nothing inside a bracketed paste clicks, even with the markers split', () => {
    expect(parse(`\x1b[200~text ${sgr(0, 1, 1)} more\x1b[201~`)).toEqual([])
    expect(parse('\x1b[20', `0~${sgr(0, 1, 1)}`, '\x1b[2', `01~${sgr(0, 7, 7)}`)).toEqual([
      ev({ x: 6, y: 6 }),
    ])
    expect(
      parse('\x1b[200~', sgr(0, 1, 1).slice(0, 4), sgr(0, 1, 1).slice(4), '\x1b[201~'),
    ).toEqual([])
  })

  test('malformed and oversized input cannot grow the pending tail', () => {
    const p = createMouseParser()
    expect(p.push('\x1b[<' + '1;'.repeat(100))).toEqual([])
    // The garbage was dropped, so a following report parses on its own.
    expect(p.push(sgr(0, 1, 1))).toEqual([ev({})])
    for (let i = 0; i < 1000; i++) p.push('\x1b[<1;')
    expect(p.push(sgr(0, 1, 1))).toEqual([ev({})])
    expect(parse('\x1b[<0;0;1M', '\x1b[<;;M', '\x1b[<a;1;1M', '[<0;1;1M')).toEqual([])
  })

  test('garbage and X10 (ESC [ M + 3 bytes) produce no events', () => {
    expect(parse('\x1b[M !!', '\x1b[M#!!', 'hello', '\x1b\x1b', '\x1bOP')).toEqual([])
  })

  test('Buffer and string chunks give the same result', () => {
    const chunks = ['x\x1b[<0;1', '0;5M', sgr(65, 2, 2)]
    expect(parse(...chunks.map((c) => Buffer.from(c)))).toEqual(parse(...chunks))
    expect(parse(...chunks)).toHaveLength(2)
  })

  test('reset forgets a half-read report and an open paste', () => {
    const p = createMouseParser()
    p.push('\x1b[<0;1')
    p.reset()
    expect(p.push('0;5M')).toEqual([])
    p.push('\x1b[200~')
    p.reset()
    expect(p.push(sgr(0, 1, 1))).toEqual([ev({})])
  })
})
