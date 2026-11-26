import { describe, expect, test } from 'bun:test'
import { readBodyCapped } from './body'

// A body of `chunks` chunks of `size` bytes, counting how many were pulled.
function countedBody(chunks: number, size: number) {
  const state = { pulled: 0 }
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled === chunks) return controller.close()
      state.pulled++
      controller.enqueue(new Uint8Array(size).fill(state.pulled))
    },
  })
  return { stream, state }
}

const tooLarge = () => new Error('too large')

describe('readBodyCapped', () => {
  test('returns a body under the cap intact', async () => {
    const { stream } = countedBody(3, 10)
    const bytes = await readBodyCapped(new Response(stream), 30, tooLarge)
    expect(bytes.byteLength).toBe(30)
    expect([bytes[0], bytes[10], bytes[29]]).toEqual([1, 2, 3])
  })

  test('stops reading as soon as the body passes the cap', async () => {
    const { stream, state } = countedBody(100, 1024)
    await expect(readBodyCapped(new Response(stream), 2500, tooLarge)).rejects.toThrow('too large')
    // Three 1 KB chunks pass 2500 bytes; the other 97 are never pulled
    // (the stream may read one ahead).
    expect(state.pulled).toBeLessThanOrEqual(4)
  })

  test('a declared Content-Length over the cap fails before reading', async () => {
    const { stream, state } = countedBody(100, 1024)
    const res = new Response(stream, { headers: { 'content-length': String(100 * 1024) } })
    await expect(readBodyCapped(res, 2500, tooLarge)).rejects.toThrow('too large')
    expect(state.pulled).toBeLessThanOrEqual(1)
  })

  test('an empty body is an empty array', async () => {
    expect((await readBodyCapped(new Response(null), 10, tooLarge)).byteLength).toBe(0)
  })
})
