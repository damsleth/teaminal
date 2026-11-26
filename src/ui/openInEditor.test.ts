import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { createAppStore } from '../state/store'
import { DISABLE_MOUSE, ENABLE_MOUSE } from './mouse'
import { mouseReportingActive, onMouse, startMouseTracker, type MouseIO } from './mouseTracker'
import { editorFromEnv, runEditor } from './openInEditor'

test('$VISUAL wins over $EDITOR; neither set means no editor', () => {
  expect(editorFromEnv({ VISUAL: 'nvim', EDITOR: 'vi' })).toBe('nvim')
  expect(editorFromEnv({ EDITOR: 'vi' })).toBe('vi')
  expect(editorFromEnv({ VISUAL: ' ' })).toBeNull()
})

test('the path reaches the editor as $1, never spliced into the command', () => {
  let seen: string[] = []
  const ok = runEditor('code -w', '/tmp/a b;rm -rf x.json', (cmd, args) => {
    seen = [cmd, ...args]
    return { status: 0, error: undefined }
  })
  expect(ok).toBe(true)
  expect(seen).toEqual(['sh', '-c', 'code -w "$1"', 'sh', '/tmp/a b;rm -rf x.json'])
})

describe('mouse reporting around the editor', () => {
  const handles: { stop: () => void }[] = []
  afterEach(() => {
    for (const h of handles.splice(0)) h.stop()
  })

  function setup(mouse: boolean) {
    const store = createAppStore()
    store.set((s) => ({ settings: { ...s.settings, mouse } }))
    const out: string[] = []
    const stdin = Object.assign(new EventEmitter(), { isTTY: true })
    const handle = startMouseTracker(store, {
      stdin: stdin as unknown as MouseIO['stdin'],
      stdout: { isTTY: true, write: (s: string) => out.push(s) },
    })
    handles.push(handle)
    const events: unknown[] = []
    const off = onMouse((e) => events.push(e))
    handles.push({ stop: off })
    return { out, stdin, handle, events }
  }

  const outcomes: [string, Parameters<typeof runEditor>[2]][] = [
    ['success', () => ({ status: 0, error: undefined })],
    ['nonzero exit', () => ({ status: 1, error: undefined })],
    [
      'thrown spawn',
      () => {
        throw new Error('ENOENT')
      },
    ],
  ]
  for (const [name, result] of outcomes) {
    test(`off before the handoff, back on after: ${name}`, () => {
      const t = setup(true)
      let during: string[] = []
      let activeDuring = true
      runEditor('ed', '/tmp/x.json', (cmd, args) => {
        during = [...t.out]
        activeDuring = mouseReportingActive()
        return result!(cmd, args)
      })
      expect(during).toEqual([ENABLE_MOUSE, DISABLE_MOUSE])
      expect(activeDuring).toBe(false)
      expect(t.out).toEqual([ENABLE_MOUSE, DISABLE_MOUSE, ENABLE_MOUSE])
      expect(mouseReportingActive()).toBe(true)
    })
  }

  test('reporting that was off stays off', () => {
    const t = setup(false)
    runEditor('ed', '/tmp/x.json', () => ({ status: 0, error: undefined }))
    expect(t.out).toEqual([])
    expect(mouseReportingActive()).toBe(false)
  })

  test('reports while suspended do nothing, and no half-report survives', () => {
    const t = setup(true)
    runEditor('ed', '/tmp/x.json', () => {
      t.stdin.emit('data', '\x1b[<0;10;5M')
      t.stdin.emit('data', '\x1b[<0;1')
      return { status: 0, error: undefined }
    })
    t.stdin.emit('data', '0;5M')
    expect(t.events).toEqual([])
    t.stdin.emit('data', '\x1b[<0;10;5M')
    expect(t.events).toHaveLength(1)
  })

  test('stopping while suspended prevents restoration', () => {
    const t = setup(true)
    runEditor('ed', '/tmp/x.json', () => {
      t.handle.stop()
      return { status: 0, error: undefined }
    })
    expect(t.out).toEqual([ENABLE_MOUSE, DISABLE_MOUSE])
    expect(mouseReportingActive()).toBe(false)
  })
})
