import { describe, expect, test, beforeEach } from 'bun:test'
import {
  __resetEventsForTests,
  debug,
  error,
  getRecentEvents,
  recordEvent,
  subscribeEvents,
  warn,
} from './log'

beforeEach(() => {
  __resetEventsForTests()
})

describe('event ring buffer', () => {
  test('recordEvent appends to the ring', () => {
    recordEvent('graph', 'info', 'GET /chats 200')
    const rs = getRecentEvents()
    expect(rs).toHaveLength(1)
    expect(rs[0]?.source).toBe('graph')
    expect(rs[0]?.level).toBe('info')
    expect(rs[0]?.message).toBe('GET /chats 200')
  })

  test('debug/warn/error tee structured records', () => {
    debug('poller[active]: fetched 3')
    warn('graph: 429 retrying')
    error('trouter: connect failed')
    const rs = getRecentEvents()
    expect(rs).toHaveLength(3)
    expect(rs[0]?.level).toBe('debug')
    expect(rs[0]?.source).toBe('poller')
    expect(rs[1]?.level).toBe('warn')
    expect(rs[1]?.source).toBe('graph')
    expect(rs[2]?.level).toBe('error')
    expect(rs[2]?.source).toBe('trouter')
  })

  test('ring buffer caps at 500 entries (oldest evicted)', () => {
    for (let i = 0; i < 600; i++) recordEvent('app', 'info', `m${i}`)
    const rs = getRecentEvents()
    expect(rs).toHaveLength(500)
    expect(rs[0]?.message).toBe('m100')
    expect(rs[499]?.message).toBe('m599')
  })

  test('subscribeEvents fires for each new record', () => {
    const seen: string[] = []
    const off = subscribeEvents((r) => seen.push(r.message))
    recordEvent('app', 'info', 'a')
    recordEvent('app', 'info', 'b')
    off()
    recordEvent('app', 'info', 'c')
    expect(seen).toEqual(['a', 'b'])
  })

  test('a throwing subscriber does not poison the logger', () => {
    subscribeEvents(() => {
      throw new Error('boom')
    })
    expect(() => recordEvent('app', 'info', 'x')).not.toThrow()
    expect(getRecentEvents()).toHaveLength(1)
  })

  test('getRecentEvents returns a fresh array', () => {
    recordEvent('app', 'info', 'x')
    const a = getRecentEvents()
    a.length = 0
    expect(getRecentEvents()).toHaveLength(1)
  })

  test('unknown prefix maps to unknown source', () => {
    debug('something not a known prefix')
    expect(getRecentEvents()[0]?.source).toBe('unknown')
  })
})
