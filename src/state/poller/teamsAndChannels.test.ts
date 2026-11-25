import { expect, test } from 'bun:test'
import { mapLimit } from './teamsAndChannels'

test('mapLimit keeps order and never runs more than the limit at once', async () => {
  let running = 0
  let peak = 0
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (n) => {
    running++
    peak = Math.max(peak, running)
    await new Promise((r) => setTimeout(r, n % 3))
    running--
    return n * 10
  })
  expect(out).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90])
  expect(peak).toBe(4)
})
