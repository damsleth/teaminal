import { describe, expect, test } from 'bun:test'
import { DEFAULT_PROFILE, accountIdForProfile, accountRef, owaProfile } from './index'

describe('accountIdForProfile', () => {
  test('is injective across aliases that sanitize or spell the default alike', () => {
    const aliases = [
      'default',
      '<default>',
      '<owa-default>',
      'a/b',
      'a_b',
      'a b',
      'a::b',
      'Work',
      'work',
      'æøå',
      'x'.repeat(80),
      'x'.repeat(81),
    ]
    const ids = [accountIdForProfile(DEFAULT_PROFILE), ...aliases.map(accountIdForProfile)]
    expect(new Set(ids).size).toBe(ids.length)
    expect(String(accountIdForProfile(DEFAULT_PROFILE))).toBe('v1:default')
  })
})

describe('accountRef / owaProfile', () => {
  test('null and undefined are the default profile, which passes no --profile', () => {
    expect(accountRef(null).profile).toBe(DEFAULT_PROFILE)
    expect(accountRef(undefined).id).toBe(accountRef(null).id)
    expect(owaProfile(accountRef(null))).toBeUndefined()
  })

  test('a named profile round-trips, even one spelled "default"', () => {
    expect(owaProfile(accountRef('swon'))).toBe('swon')
    expect(owaProfile(accountRef('default'))).toBe('default')
    expect(accountRef('default').id).not.toBe(accountRef(null).id)
  })
})
