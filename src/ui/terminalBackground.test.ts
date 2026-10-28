import { expect, test } from 'bun:test'
import { parseBackgroundProbe } from './terminalBackground'

test('a light or dark OSC 11 background reply picks that appearance', () => {
  expect(parseBackgroundProbe('\x1b]11;rgb:ffff/ffff/ffff\x1b\\')).toBe('light')
  expect(parseBackgroundProbe('\x1b]11;rgb:f7/f7/f7\x07\x1b[?62;22c')).toBe('light')
  expect(parseBackgroundProbe('\x1b]11;rgb:1c1c/1c1c/1c1c\x1b\\')).toBe('dark')
  // Mid gray sits below half luminance: dark.
  expect(parseBackgroundProbe('\x1b]11;rgb:8080/8080/8080\x07')).toBe('dark')
})

test('DA1 without OSC 11 means no answer; nothing yet means keep waiting', () => {
  expect(parseBackgroundProbe('\x1b[?62;22c')).toBeUndefined()
  expect(parseBackgroundProbe('')).toBeNull()
  expect(parseBackgroundProbe('\x1b]11;rg')).toBeNull()
})
