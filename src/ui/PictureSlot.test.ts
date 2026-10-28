import { expect, test } from 'bun:test'
import { initialsOf } from './PictureSlot'

test('initials come from words that start with a letter', () => {
  expect(initialsOf('Lovelace, Ada')).toBe('LA')
  expect(initialsOf('Carl Joakim Damsleth')).toBe('CJ')
  expect(initialsOf('Øivind Eriksen')).toBe('ØE')
  expect(initialsOf('(1:1)')).toBe('')
  expect(initialsOf('🐷 (x)')).toBe('X')
})
