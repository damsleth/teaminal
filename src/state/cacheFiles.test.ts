import { describe, expect, test } from 'bun:test'
import { debouncedWriter } from './cacheFiles'

describe('debouncedWriter', () => {
  test('two paths scheduled inside one debounce window both persist', async () => {
    const written: [string, string][] = []
    const w = debouncedWriter<string>((snap, path) => written.push([path, snap]))
    w.schedule('a1', '/a', 5)
    w.schedule('b1', '/b', 5)
    w.schedule('a2', '/a', 5) // latest snapshot for /a wins, /b is untouched
    await new Promise((r) => setTimeout(r, 20))
    expect(written.sort()).toEqual([
      ['/a', 'a2'],
      ['/b', 'b1'],
    ])
  })

  test('flush writes every pending path at once and cancels the timers', async () => {
    const written: string[] = []
    const w = debouncedWriter<string>((_snap, path) => written.push(path))
    w.schedule('x', '/a', 1000)
    w.schedule('y', '/b', 1000)
    w.flush()
    expect(written.sort()).toEqual(['/a', '/b'])
    await new Promise((r) => setTimeout(r, 5))
    expect(written).toHaveLength(2)
  })

  test('a failing write does not throw or block the others', () => {
    const written: string[] = []
    const w = debouncedWriter<string>((_snap, path) => {
      if (path === '/bad') throw new Error('disk full')
      written.push(path)
    })
    w.schedule('x', '/bad', 1000)
    w.schedule('y', '/ok', 1000)
    expect(() => w.flush()).not.toThrow()
    expect(written).toEqual(['/ok'])
  })
})
