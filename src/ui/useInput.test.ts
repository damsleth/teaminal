import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { PassThrough } from 'node:stream'
import { render } from 'ink'
import { createElement } from 'react'
import { isMouseReport } from './mouse'
import { isFocusReport, useInput } from './useInput'

describe('isFocusReport', () => {
  test('matches the de-escaped DEC 1004 reports only', () => {
    expect(isFocusReport('[I')).toBe(true)
    expect(isFocusReport('[O')).toBe(true)
    expect(isFocusReport('[')).toBe(false)
    expect(isFocusReport('I')).toBe(false)
    expect(isFocusReport('[Ia')).toBe(false)
  })

  test('no UI component imports the unfiltered hook from ink', () => {
    const offenders = readdirSync(import.meta.dir).filter((name) => {
      if (!/\.tsx?$/.test(name) || name === 'useInput.ts') return false
      const src = readFileSync(`${import.meta.dir}/${name}`, 'utf8')
      return /import \{[^}]*\buseInput\b[^}]*\} from 'ink'/.test(src)
    })
    expect(offenders).toEqual([])
  })
})

describe('isMouseReport', () => {
  test('whole de-escaped reports and flushed heads', () => {
    expect(isMouseReport('[<0;10;5M')).toBe(true)
    expect(isMouseReport('[<65;3;4M')).toBe(true)
    expect(isMouseReport('[<0;10;5m')).toBe(true)
    expect(isMouseReport('[<0;1')).toBe(true)
    expect(isMouseReport('[<')).toBe(true) // a typed "[<" is dropped too
  })

  test('other input passes', () => {
    expect(isMouseReport('[')).toBe(false)
    expect(isMouseReport('[I')).toBe(false)
    expect(isMouseReport('<')).toBe(false)
    expect(isMouseReport('[<a')).toBe(false)
    expect(isMouseReport('[<0;10;5Mx')).toBe(false)
    expect(isMouseReport('[<0;1 hello')).toBe(false)
    expect(isMouseReport('0;5M')).toBe(false)
  })
})

describe('useInput', () => {
  const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))
  function mount() {
    const seen: string[] = []
    function Probe() {
      useInput((input) => {
        seen.push(input)
      })
      return null
    }
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { isTTY: boolean }
    stdin.isTTY = true
    stdin.setRawMode = () => stdin
    stdin.ref = () => stdin
    stdin.unref = () => stdin
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream
    const app = render(createElement(Probe), {
      stdin,
      stdout,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    return { seen, stdin, app }
  }

  test('mouse reports never reach the handler', async () => {
    const { seen, stdin, app } = mount()
    await tick()
    stdin.write('\x1b[<0;10;5M')
    await tick()
    stdin.write('\x1b[<65;3;4M\x1b[<64;3;4M')
    await tick()
    stdin.write('a')
    await tick()
    expect(seen).toEqual(['a'])
    app.unmount()
  })

  // Known leak (plan Risks): a report split by a gap longer than Ink's 20 ms
  // escape flush arrives as a head, dropped, and a tail that reads as text.
  test('the tail of a report split past the escape flush gets through', async () => {
    const { seen, stdin, app } = mount()
    await tick()
    stdin.write('\x1b[<0;1')
    await tick(80)
    stdin.write('0;5M')
    await tick()
    expect(seen).toEqual(['0;5M'])
    app.unmount()
  })
})
