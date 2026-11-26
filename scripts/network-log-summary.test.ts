import { expect, test } from 'bun:test'
import { summarize } from './network-log-summary'

const log = [
  '[2026-01-01T10:00:00.000Z] GET   200 120ms /me @alpha',
  '[2026-01-01T10:00:01.000Z] GET   200 90ms /me @beta',
  '[2026-01-01T10:01:00.000Z] GET   200 80ms /chats @alpha',
  '[2026-01-01T10:02:00.000Z] GET   429 10ms /chats @beta r429',
  '[2026-01-01T10:03:00.000Z] GET   ERR 5ms /chats @alpha err=connect failed @host',
  '[2026-01-01T10:04:00.000Z] GET   200 70ms /users/:id/presence',
  'not a request line',
].join('\n')

test('requests per minute per account over one shared window', () => {
  const s = summarize(log)
  expect(s.windowMinutes).toBe(4)
  expect(s.total).toBe(6)
  expect(s.accounts).toEqual([
    { account: 'alpha', requests: 3, perMinute: 0.75, errors: 1, throttled: 0 },
    { account: 'beta', requests: 2, perMinute: 0.5, errors: 1, throttled: 1 },
    { account: '(untagged)', requests: 1, perMinute: 0.25, errors: 0, throttled: 0 },
  ])
})

test('--skip-minutes drops the startup burst', () => {
  const s = summarize(log, 2)
  expect(s.total).toBe(3)
  expect(s.windowMinutes).toBe(2)
  expect(s.accounts.map((a) => [a.account, a.requests])).toEqual([
    ['beta', 1],
    ['alpha', 1],
    ['(untagged)', 1],
  ])
})
