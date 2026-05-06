import { describe, expect, test, beforeEach } from 'bun:test'
import {
  __resetEventsForTests,
  debug,
  error,
  getRecentEvents,
  recordEvent,
  redactForFile,
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

describe('request log ring buffer', () => {
  test('recordRequest accumulates and emits to subscribers', async () => {
    const { recordRequest, getRecentRequests, subscribeRequests } = await import('./log')
    const seen: number[] = []
    const off = subscribeRequests((r) => seen.push(r.status ?? -1))
    recordRequest({ ts: 1, method: 'GET', path: '/chats', status: 200, durationMs: 12 })
    recordRequest({ ts: 2, method: 'GET', path: '/me/presence', status: 429, durationMs: 5 })
    off()
    expect(getRecentRequests().map((r) => r.status)).toEqual([200, 429])
    expect(seen).toEqual([200, 429])
  })

  test('request ring caps at 200 entries', async () => {
    const { recordRequest, getRecentRequests } = await import('./log')
    for (let i = 0; i < 250; i++) {
      recordRequest({ ts: i, method: 'GET', path: `/p${i}`, status: 200, durationMs: 1 })
    }
    const rs = getRecentRequests()
    expect(rs).toHaveLength(200)
    expect(rs[0]?.path).toBe('/p50')
    expect(rs[199]?.path).toBe('/p249')
  })
})

describe('log file redaction', () => {
  test('redacts Bearer tokens', () => {
    const out = redactForFile('Authorization: Bearer abc123def456_ghi-jkl.mno')
    expect(out).toContain('<redacted>')
    expect(out).not.toContain('abc123def456')
  })

  test('redacts AAD-style ids', () => {
    const id = '12345678-aaaa-bbbb-cccc-1234567890ab'
    const out = redactForFile(`oid=${id}`)
    expect(out).toBe('oid=<oid:12345678>')
  })

  test('masks email local-part but keeps domain', () => {
    const out = redactForFile('user.name+tag@contoso.onmicrosoft.com replied')
    expect(out).toBe('<email:***@contoso.onmicrosoft.com> replied')
  })

  test('passthroughs benign lines unchanged', () => {
    const line = '[ts] poller[active]: fetched 3 messages\n'
    expect(redactForFile(line)).toBe(line)
  })
})
