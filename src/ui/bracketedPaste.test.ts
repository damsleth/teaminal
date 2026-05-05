import { describe, expect, test } from 'bun:test'
import { feed, initialParserState, type ParserState } from './bracketedPaste'

const ESC = '\x1b'
const START = `${ESC}[200~`
const END = `${ESC}[201~`

function run(chunks: string[]): { events: ReturnType<typeof feed>['events']; state: ParserState } {
  let state = initialParserState
  const all: ReturnType<typeof feed>['events'] = []
  for (const chunk of chunks) {
    const r = feed(state, chunk)
    state = r.state
    all.push(...r.events)
  }
  return { events: all, state }
}

describe('bracketed-paste parser', () => {
  test('plain input passes through as one plain event', () => {
    const { events, state } = run(['hello'])
    expect(events).toEqual([{ kind: 'plain', chars: 'hello' }])
    expect(state.inPaste).toBe(false)
  })

  test('full paste in one chunk emits a single paste event', () => {
    const { events, state } = run([`${START}line one\nline two${END}`])
    expect(events).toEqual([{ kind: 'paste', chars: 'line one\nline two' }])
    expect(state.inPaste).toBe(false)
  })

  test('paste split across two chunks reassembles cleanly', () => {
    const { events, state } = run([`${START}line one\n`, `line two${END}`])
    // Two paste events whose concatenation matches the full payload.
    const merged = events
      .filter((e) => e.kind === 'paste')
      .map((e) => e.chars)
      .join('')
    expect(merged).toBe('line one\nline two')
    expect(state.inPaste).toBe(false)
  })

  test('paste straddling at an escape boundary is buffered', () => {
    // Send the start sequence broken across two chunks.
    const { events, state } = run([`${ESC}[2`, `00~hello${END}`])
    expect(
      events
        .filter((e) => e.kind === 'paste')
        .map((e) => e.chars)
        .join(''),
    ).toBe('hello')
    expect(state.inPaste).toBe(false)
  })

  test('plain text mixed with paste preserves order', () => {
    const { events } = run([`abc${START}xyz${END}def`])
    expect(events).toEqual([
      { kind: 'plain', chars: 'abc' },
      { kind: 'paste', chars: 'xyz' },
      { kind: 'plain', chars: 'def' },
    ])
  })

  test('end terminator straddling chunk boundary works', () => {
    const { events, state } = run([`${START}xyz${ESC}`, `[201~`])
    expect(
      events
        .filter((e) => e.kind === 'paste')
        .map((e) => e.chars)
        .join(''),
    ).toBe('xyz')
    expect(state.inPaste).toBe(false)
  })

  test('keeps inPaste=true if no end yet', () => {
    const { state } = run([`${START}partial`])
    expect(state.inPaste).toBe(true)
  })
})
