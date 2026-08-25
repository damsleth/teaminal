import { describe, expect, test } from 'bun:test'
import { renderCleanExit } from './shutdown'

function fakeStdout(isTTY: boolean): { stream: NodeJS.WriteStream; writes: string[] } {
  const writes: string[] = []
  const stream = {
    isTTY,
    write: (chunk: string) => {
      writes.push(chunk)
      return true
    },
  } as unknown as NodeJS.WriteStream
  return { stream, writes }
}

describe('renderCleanExit', () => {
  test('clears the screen and deletes Kitty placements on a TTY', () => {
    const { stream, writes } = fakeStdout(true)
    expect(renderCleanExit(stream)).toBe(true)
    const all = writes.join('')
    expect(all).toContain('\x1b_Ga=d') // Kitty delete
    expect(all).toContain('\x1b[2J') // clear visible screen
    expect(all).toContain('\x1b[H') // cursor home
    expect(all).toContain('\x1b[?25h') // cursor visible again
    // The user's shell scrollback above teaminal is not ours to erase.
    expect(all).not.toContain('\x1b[3J')
  })

  test('writes nothing when stdout is not a TTY', () => {
    const { stream, writes } = fakeStdout(false)
    expect(renderCleanExit(stream)).toBe(false)
    expect(writes).toEqual([])
  })
})
