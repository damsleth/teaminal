import { describe, expect, test } from 'bun:test'
import { makeSleeper } from './sleeper'

describe('makeSleeper', () => {
  test('sleep resolves after the requested duration', async () => {
    const s = makeSleeper()
    const start = Date.now()
    await s.sleep(50)
    const elapsed = Date.now() - start
    // Allow a small lower-bound tolerance — some platforms wake a hair early.
    expect(elapsed).toBeGreaterThanOrEqual(40)
    expect(elapsed).toBeLessThan(200)
  })

  test('wake() resolves an in-flight sleep early', async () => {
    const s = makeSleeper()
    const start = Date.now()
    setTimeout(() => s.wake(), 10)
    await s.sleep(10_000)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(200)
  })

  test('wake() with no active sleep is a no-op', () => {
    const s = makeSleeper()
    expect(() => s.wake()).not.toThrow()
  })

  test('subsequent sleep after wake works normally', async () => {
    const s = makeSleeper()
    setTimeout(() => s.wake(), 5)
    await s.sleep(1_000)
    const start = Date.now()
    await s.sleep(20)
    expect(Date.now() - start).toBeGreaterThanOrEqual(15)
  })

  test('multiple wake calls during one sleep are idempotent', async () => {
    const s = makeSleeper()
    setTimeout(() => {
      s.wake()
      s.wake()
      s.wake()
    }, 5)
    await s.sleep(1_000)
    // No assertion: just verify we don't throw on the redundant wakes.
  })
})
