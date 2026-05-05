import { describe, expect, test } from 'bun:test'
import { backoff, isAbortError, jitter } from './intervals'

describe('jitter', () => {
  test('returns a value within ±20% of the input', () => {
    for (let i = 0; i < 1000; i++) {
      const j = jitter(1000)
      expect(j).toBeGreaterThanOrEqual(800)
      expect(j).toBeLessThanOrEqual(1200)
    }
  })

  test('rounds to an integer', () => {
    for (let i = 0; i < 100; i++) {
      const j = jitter(123)
      expect(Number.isInteger(j)).toBe(true)
    }
  })

  test('zero input maps to zero', () => {
    expect(jitter(0)).toBe(0)
  })
})

describe('backoff', () => {
  test('returns the base interval when no errors have occurred', () => {
    expect(backoff(5_000, 0)).toBe(5_000)
  })

  test('grows exponentially with consecutive errors', () => {
    expect(backoff(1_000, 1)).toBeCloseTo(1_500, 0)
    expect(backoff(1_000, 2)).toBeCloseTo(2_250, 0)
    expect(backoff(1_000, 3)).toBeCloseTo(3_375, 0)
  })

  test('caps at 60_000 ms regardless of consecutive count', () => {
    expect(backoff(5_000, 100)).toBe(60_000)
    expect(backoff(60_001, 0)).toBe(60_001) // base higher than cap, no error: pass-through
    expect(backoff(60_001, 1)).toBe(60_000) // any error caps it
  })
})

describe('isAbortError', () => {
  test('matches an Error with name === "AbortError"', () => {
    const err = new Error('cancelled')
    err.name = 'AbortError'
    expect(isAbortError(err)).toBe(true)
  })

  test('matches errors whose message contains "abort" or "aborted"', () => {
    expect(isAbortError(new Error('the operation was aborted'))).toBe(true)
    expect(isAbortError(new Error('Request abort'))).toBe(true)
    expect(isAbortError(new Error('ABORTED'))).toBe(true)
  })

  test('does not match unrelated errors', () => {
    expect(isAbortError(new Error('network error'))).toBe(false)
    expect(isAbortError(new Error('rate limited'))).toBe(false)
  })

  test('does not match non-Error values', () => {
    expect(isAbortError('aborted')).toBe(false)
    expect(isAbortError(undefined)).toBe(false)
    expect(isAbortError(null)).toBe(false)
    expect(isAbortError({ message: 'aborted' })).toBe(false)
  })
})
