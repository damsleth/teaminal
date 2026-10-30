import { expect, test } from 'bun:test'
import { parseStatusEnd } from './presenceActions'

const now = new Date(2026, 9, 30, 12, 0)

test('parseStatusEnd', () => {
  expect(parseStatusEnd('', now)).toBeUndefined()
  expect(parseStatusEnd('30m', now)?.getTime()).toBe(now.getTime() + 30 * 60e3)
  expect(parseStatusEnd('2h', now)?.getTime()).toBe(now.getTime() + 2 * 3600e3)
  expect(parseStatusEnd('today', now)).toEqual(new Date(2026, 9, 30, 23, 59))
  expect(parseStatusEnd('tomorrow', now)).toEqual(new Date(2026, 9, 31, 23, 59))
  expect(parseStatusEnd('15:30', now)).toEqual(new Date(2026, 9, 30, 15, 30))
  expect(parseStatusEnd('09:00', now)).toEqual(new Date(2026, 9, 31, 9, 0))
  expect(parseStatusEnd('2026-11-02 08:15', now)).toEqual(new Date(2026, 10, 2, 8, 15))
  expect(parseStatusEnd('2026-10-01', now)).toBeNull()
  expect(parseStatusEnd('25:00', now)).toBeNull()
  expect(parseStatusEnd('soon', now)).toBeNull()
})
