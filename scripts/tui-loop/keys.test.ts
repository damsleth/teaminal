import { describe, expect, test } from 'bun:test'
import { encodeKey } from './keys'

const ESC = String.fromCharCode(0x1b)

describe('encodeKey', () => {
  test('maps named keys to control bytes', () => {
    expect(encodeKey('enter')).toBe('\r')
    expect(encodeKey('esc')).toBe(ESC)
    expect(encodeKey('up')).toBe(`${ESC}[A`)
    expect(encodeKey('ctrl-c')).toBe(String.fromCharCode(3))
  })

  test('passes unknown keys through verbatim', () => {
    expect(encodeKey('j')).toBe('j')
    expect(encodeKey('x')).toBe('x')
  })
})
