import { expect, test } from 'bun:test'
import { parseKittyKeyboardProbe } from './kittyKeyboard'

test('a kitty flags reply means supported', () => {
  expect(parseKittyKeyboardProbe('\x1b[?0u\x1b[?62;22c')).toBe(true)
  expect(parseKittyKeyboardProbe('\x1b[?1u')).toBe(true)
})

test('DA1 without a flags reply means unsupported', () => {
  expect(parseKittyKeyboardProbe('\x1b[?62;4;22c')).toBe(false)
  expect(parseKittyKeyboardProbe('\x1b[?1;2c')).toBe(false)
})

test('nothing conclusive yet', () => {
  expect(parseKittyKeyboardProbe('')).toBeNull()
  expect(parseKittyKeyboardProbe('\x1b[?6')).toBeNull()
})
