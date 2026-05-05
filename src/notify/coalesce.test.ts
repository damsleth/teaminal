import { describe, expect, test } from 'bun:test'
import { makeCoalescer, type Banner } from './coalesce'

function setup() {
  const fired: Banner[] = []
  const c = makeCoalescer({
    notify: (b) => fired.push(b),
  })
  return { c, fired }
}

const conv1 = 'chat:c1' as const
const conv2 = 'chat:c2' as const

describe('coalescer', () => {
  test('a single mention fires immediately', () => {
    const { c, fired } = setup()
    c.enqueue(
      {
        conv: conv1,
        title: 'teaminal · chat',
        body: 'Carl: hi',
        senderName: 'Carl',
        preview: 'hi',
      },
      0,
    )
    expect(fired).toHaveLength(1)
    expect(fired[0]?.body).toBe('Carl: hi')
  })

  test('mentions in the same conv coalesce into a digest at window expiry', () => {
    const { c, fired } = setup()
    for (let i = 0; i < 5; i++) {
      c.enqueue(
        {
          conv: conv1,
          title: 't',
          body: '',
          senderName: 'Carl',
          preview: `m${i}`,
        },
        i * 1000,
      )
    }
    // First fired immediately. The 4 follow-ups buffered.
    expect(fired).toHaveLength(1)

    c.drain(31_000)
    // Window expired: digest banner emitted.
    expect(fired).toHaveLength(2)
    expect(fired[1]?.body).toMatch(/Carl: m4\s+\(\+4 more\)/)
  })

  test('mentions in two convs each fire immediately', () => {
    const { c, fired } = setup()
    c.enqueue({ conv: conv1, title: 't', body: '', senderName: 'Carl', preview: 'a' }, 0)
    // Inside the rate-limit window for the second conv: gets buffered.
    c.enqueue({ conv: conv2, title: 't', body: '', senderName: 'Nina', preview: 'b' }, 1000)
    expect(fired).toHaveLength(1)
    // After the rate-limit window passes, drain emits the second.
    c.drain(35_000)
    expect(fired).toHaveLength(2)
  })

  test('global rate limit holds back rapid bursts ≥ rateLimitMs apart', () => {
    const fired: Banner[] = []
    const c = makeCoalescer({
      notify: (b) => fired.push(b),
      rateLimitMs: 5_000,
    })
    // Two different convs in quick succession: only the first fires
    // immediately; the second waits for the rate limit.
    c.enqueue({ conv: conv1, title: 't', body: '', senderName: 'Carl', preview: 'a' }, 0)
    c.enqueue({ conv: conv2, title: 't', body: '', senderName: 'Nina', preview: 'b' }, 1000)
    expect(fired).toHaveLength(1)
    c.drain(31_000)
    // Now both windows expire and the second conv flushes; the rate
    // limit at 31s allows it (>5s after the last fire at 0).
    expect(fired.length).toBeGreaterThanOrEqual(2)
  })

  test('cap forces a flush even if window keeps getting reset', () => {
    const fired: Banner[] = []
    const c = makeCoalescer({
      notify: (b) => fired.push(b),
      coalesceWindowMs: 30_000,
      coalesceCapMs: 90_000,
    })
    // First mention fires; subsequent buffered.
    c.enqueue({ conv: conv1, title: 't', body: '', senderName: 'A', preview: '0' }, 0)
    for (let i = 1; i <= 100; i++) {
      c.enqueue({ conv: conv1, title: 't', body: '', senderName: 'A', preview: `${i}` }, i * 1000)
    }
    // Cap is 90s; somewhere around 90s we should have force-flushed.
    expect(fired.length).toBeGreaterThanOrEqual(2)
  })

  test('digest groups multiple senders', () => {
    const { c, fired } = setup()
    c.enqueue({ conv: conv1, title: 't', body: '', senderName: 'A', preview: '1' }, 0)
    c.enqueue({ conv: conv1, title: 't', body: '', senderName: 'B', preview: '2' }, 1000)
    c.enqueue({ conv: conv1, title: 't', body: '', senderName: 'C', preview: '3' }, 2000)
    c.drain(35_000)
    expect(fired).toHaveLength(2)
    expect(fired[1]?.body).toMatch(/B \(\+1\): 3/)
  })
})
