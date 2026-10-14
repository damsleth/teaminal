import { describe, expect, test } from 'bun:test'
import { DEFAULT_PROFILE, accountIdForProfile, accountRef, owaProfile, profileSlug } from './index'

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

describe('profileSlug', () => {
  const slug = (p: string | null) => profileSlug(accountRef(p))

  test('the default profile (null, undefined, empty) has no slug', () => {
    expect(slug(null)).toBeNull()
    expect(slug('')).toBeNull()
  })

  test('filename-safe aliases keep their name so existing caches still load', () => {
    expect(slug('swon')).toBe('swon')
    expect(slug('work.v2_x-1')).toBe('work.v2_x-1')
  })

  test('is injective where plain sanitizing collided', () => {
    const pairs: [string, string][] = [
      ['a/b', 'a_b'],
      ['a b', 'a_b'],
      ['x'.repeat(64) + 'a', 'x'.repeat(64) + 'b'],
    ]
    for (const [a, b] of pairs) expect(slug(a)).not.toBe(slug(b))
  })

  test('encoded slugs cannot equal a literal alias', () => {
    // A literal alias spelled like an encoding is itself not filename-safe
    // (it contains `~`), so it is encoded again rather than passed through.
    expect(slug('a/b')).toBe('~a~2Fb')
    expect(slug('~a~2Fb')).not.toBe(slug('a/b'))
    expect(slug('a_b')).toBe('a_b')
  })

  test('never names the default image dir, a dot dir or anything with a separator', () => {
    for (const p of ['default', '.', '..', '../escape', 'a/b', 'æøå']) {
      const s = slug(p)!
      expect(s).not.toBe('default')
      expect(s.startsWith('.')).toBe(false)
      expect(s).toMatch(/^[A-Za-z0-9_~-]+$/)
    }
  })
})
