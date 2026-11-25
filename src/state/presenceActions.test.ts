import { expect, test } from 'bun:test'
import { accountRef } from '../account'
import { openAccount, type AccountStore } from './accountStore'
import { parseStatusEnd, setStatusNoteOnAll } from './presenceActions'
import { createAppStore } from './store'

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

test('setStatusNoteOnAll: every account gets the note; failures are named by label', async () => {
  const store = createAppStore()
  const accs = ['alpha', 'beta', 'gamma'].map((p, i) =>
    openAccount(store, accountRef(p), { foreground: i === 0 }),
  )
  const sent: string[] = []
  const setOne = async (acc: AccountStore, message: string) => {
    if (acc.ref.label === 'beta') throw new Error('403 forbidden')
    sent.push(`${acc.ref.label}:${message}`)
  }
  await expect(setStatusNoteOnAll(accs, 'lunch', null, setOne)).rejects.toThrow(
    'beta: 403 forbidden',
  )
  expect(sent).toEqual(['alpha:lunch', 'gamma:lunch'])
  await setStatusNoteOnAll([accs[0]!, accs[2]!], '', null, setOne)
  expect(sent).toEqual(['alpha:lunch', 'gamma:lunch', 'alpha:', 'gamma:'])
})
