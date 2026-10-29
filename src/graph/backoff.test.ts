import { afterEach, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  __setBackoffSleepForTests,
  backoff429Ms,
  fetchWithBackoff,
  MAX_429_RETRIES,
} from './backoff'

afterEach(() => __setBackoffSleepForTests(null))

test('the wait doubles per attempt, is capped, and never undercuts Retry-After', () => {
  const noJitter = () => 0
  expect([0, 1, 2, 3].map((n) => backoff429Ms(n, 0, noJitter))).toEqual([1000, 2000, 4000, 8000])
  expect(backoff429Ms(10, 0, noJitter)).toBe(30_000)
  expect(backoff429Ms(0, 5000, noJitter)).toBe(5000)
  // Jitter only lengthens the wait, by at most 20%.
  expect(backoff429Ms(1, 0, () => 1)).toBe(2400)
})

test('a 429 is retried with growing waits until it succeeds', async () => {
  const waits: number[] = []
  __setBackoffSleepForTests(async (ms) => void waits.push(ms))
  let calls = 0
  const res = await fetchWithBackoff(async () =>
    ++calls < 3 ? new Response('', { status: 429 }) : new Response('ok', { status: 200 }),
  )
  expect(res.status).toBe(200)
  expect(calls).toBe(3)
  expect(waits[1]!).toBeGreaterThan(waits[0]!)
})

test('after MAX_429_RETRIES the 429 is returned to the caller', async () => {
  __setBackoffSleepForTests(async () => {})
  let calls = 0
  const res = await fetchWithBackoff(async () => {
    calls++
    return new Response('', { status: 429 })
  })
  expect(res.status).toBe(429)
  expect(calls).toBe(MAX_429_RETRIES + 1)
})

test('an abort ends the wait', async () => {
  __setBackoffSleepForTests(() => new Promise(() => {}))
  const ctrl = new AbortController()
  const pending = fetchWithBackoff(
    async () => new Response('', { status: 429 }),
    ctrl.signal,
  ).catch((e) => e)
  await new Promise((r) => setTimeout(r, 5))
  ctrl.abort()
  expect(((await pending) as Error).name).toBe('AbortError')
})

test('every Teams-service request goes through the 429 back-off', () => {
  const dir = import.meta.dir
  for (const file of readdirSync(dir)) {
    if (!/^teams.*\.ts$/.test(file) || file.endsWith('.test.ts')) continue
    const src = readFileSync(join(dir, file), 'utf8')
    expect({ file, bare: /await transport\(/.test(src) }).toEqual({ file, bare: false })
  }
})
