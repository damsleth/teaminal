import { afterEach, expect, test } from 'bun:test'
import { createAppStore } from '../state/store'
import { makeCoalescer, type Banner } from './coalesce'
import { __setCoalescerForTests, drainNotifications, notifyMention } from './index'

afterEach(() => __setCoalescerForTests(null))

function capture(): Banner[] {
  const banners: Banner[] = []
  __setCoalescerForTests(makeCoalescer({ notify: (b) => banners.push(b), rateLimitMs: 0 }))
  return banners
}

const ctx = (now: number) => {
  const s = createAppStore().get()
  return {
    now: new Date(now),
    terminalFocused: false,
    state: { focus: s.focus, myPresence: s.myPresence, settings: s.settings },
  }
}

const alpha = { id: 'v1:p:alpha', label: 'alpha' }
const beta = { id: 'v1:p:beta', label: 'beta' }

test('one account: the title has no account label', () => {
  const banners = capture()
  notifyMention(
    { conv: 'chat:c1', senderName: 'Alice', preview: 'hi', scope: 'Bob', account: alpha },
    ctx(1_000),
  )
  notifyMention(
    { conv: 'chat:c2', senderName: 'Alice', preview: 'hi', scope: 'channel:general' },
    ctx(2_000),
  )
  expect(banners.map((b) => b.title)).toEqual(['teaminal · Bob', 'teaminal · #general'])
})

test('two accounts with the same conv id coalesce separately and keep their labels', () => {
  const banners = capture()
  const mention = (account: typeof alpha, preview: string, now: number) =>
    notifyMention(
      { conv: 'chat:c1', senderName: 'Alice', preview, scope: 'Bob', account, labelled: true },
      ctx(now),
    )
  // First in each account fires at once: two windows, not one.
  mention(alpha, 'a1', 1_000)
  mention(beta, 'b1', 1_100)
  expect(banners.map((b) => [b.title, b.body])).toEqual([
    ['teaminal · alpha · Bob', 'Alice: a1'],
    ['teaminal · beta · Bob', 'Alice: b1'],
  ])
  // Follow-ups buffer per account; each digest carries its own label.
  mention(alpha, 'a2', 2_000)
  mention(beta, 'b2', 2_100)
  drainNotifications(40_000)
  expect(banners.slice(2).map((b) => [b.title, b.body])).toEqual([
    ['teaminal · alpha · Bob', 'Alice: a2'],
    ['teaminal · beta · Bob', 'Alice: b2'],
  ])
})
