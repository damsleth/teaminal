import { describe, expect, test } from 'bun:test'
import { localDate, localTime } from './localTime'

describe('localTime / localDate', () => {
  test('render in the local zone, not UTC', () => {
    // Built from local fields, so this holds in any TZ the tests run under.
    const d = new Date(2026, 9, 27, 0, 30)
    expect(localTime(d.toISOString())).toBe('00:30')
    expect(localDate(d.toISOString())).toBe('2026-10-27')
  })

  test('unparseable input falls back to the raw slice', () => {
    expect(localTime('not-a-dateTHH:MM')).toBe('HH:MM')
    expect(localDate('not-a-dateTHH:MM')).toBe('not-a-date')
  })
})
