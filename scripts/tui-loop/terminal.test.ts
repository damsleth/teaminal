import { describe, expect, test } from 'bun:test'
import { TerminalGrid } from './terminal'

const ESC = ''

describe('TerminalGrid', () => {
  test('writes printable text and cursor positioning', () => {
    const terminal = new TerminalGrid(10, 3)
    terminal.write('hello')
    terminal.write(`${ESC}[2;3Hxy`)

    expect(terminal.toText()).toBe('hello\n  xy\n')
  })

  test('handles clear screen and line erasure', () => {
    const terminal = new TerminalGrid(8, 2)
    terminal.write('abcdef')
    terminal.write(`${ESC}[1;3H${ESC}[K`)

    expect(terminal.toText()).toBe('ab\n')

    terminal.write(`${ESC}[2Jafter`)
    expect(terminal.toText()).toBe('after\n')
  })

  test('tracks basic sgr colors', () => {
    const terminal = new TerminalGrid(4, 1)
    terminal.write(`${ESC}[31;1mR`)
    const first = terminal.snapshot()[0]![0]!

    expect(first.char).toBe('R')
    expect(first.fg).toBe('#cc3333')
    expect(first.bold).toBe(true)
  })

  test('decodes 256-color and truecolor foregrounds', () => {
    const terminal = new TerminalGrid(3, 1)
    terminal.write(`${ESC}[38;5;196mA${ESC}[38;2;10;20;30mB${ESC}[39mC`)
    const [a, b, c] = terminal.snapshot()[0]!

    expect(a!.fg).toBe('#ff0000') // 256 index 196 = top of the red cube
    expect(b!.fg).toBe('#0a141e')
    expect(c!.fg).toBeNull()
  })

  test('256-color background and grayscale ramp', () => {
    const terminal = new TerminalGrid(2, 1)
    terminal.write(`${ESC}[48;5;236mX${ESC}[49mY`)
    const [x, y] = terminal.snapshot()[0]!

    expect(x!.bg).toBe('#303030') // index 236 = 8 + (236-232)*10 = 48 → 0x30
    expect(y!.bg).toBeNull()
  })

  test('tracks reverse video on and off', () => {
    const terminal = new TerminalGrid(2, 1)
    terminal.write(`${ESC}[7mA${ESC}[27mB`)
    const [a, b] = terminal.snapshot()[0]!

    expect(a!.inverse).toBe(true)
    expect(b!.inverse).toBe(false)
  })

  test('wide characters occupy two columns', () => {
    const terminal = new TerminalGrid(6, 1)
    terminal.write('中x')
    const row = terminal.snapshot()[0]!

    expect(row[0]!.char).toBe('中')
    expect(row[1]!.char).toBe('') // continuation cell keeps alignment
    expect(row[2]!.char).toBe('x')
    expect(terminal.toText()).toBe('中x')
  })

  test('drops zero-width combining marks', () => {
    const terminal = new TerminalGrid(4, 1)
    terminal.write('éy') // e + combining acute + y
    const row = terminal.snapshot()[0]!

    expect(row[0]!.char).toBe('e')
    expect(row[1]!.char).toBe('y')
  })
})
