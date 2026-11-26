import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { createAppStore } from '../state/store'
import { DISABLE_MOUSE, ENABLE_MOUSE, type MouseEvent } from './mouse'
import {
  mouseReportingActive,
  onMouse,
  startMouseTracker,
  type MouseIO,
  type MouseTrackerHandle,
} from './mouseTracker'

const handles: MouseTrackerHandle[] = []
const unsubscribes: (() => void)[] = []
afterEach(() => {
  for (const h of handles.splice(0)) h.stop()
  for (const u of unsubscribes.splice(0)) u()
})

function setup(mouse: boolean, tty = true) {
  const store = createAppStore()
  store.set((s) => ({ settings: { ...s.settings, mouse } }))
  const out: string[] = []
  const stdin = Object.assign(new EventEmitter(), { isTTY: tty }) as unknown as MouseIO['stdin']
  const io: MouseIO = {
    stdin,
    stdout: {
      isTTY: tty,
      write: (s: string) => {
        out.push(s)
        return true
      },
    },
  }
  const events: MouseEvent[] = []
  unsubscribes.push(onMouse((e) => events.push(e)))
  const handle = startMouseTracker(store, io)
  handles.push(handle)
  const setMouse = (on: boolean) => store.set((s) => ({ settings: { ...s.settings, mouse: on } }))
  const send = (chunk: string | Buffer) => (stdin as unknown as EventEmitter).emit('data', chunk)
  return { store, out, events, handle, setMouse, send }
}

const click = '\x1b[<0;10;5M'

describe('startMouseTracker', () => {
  test('off: inert, then toggling the setting writes enable, then disable', () => {
    const t = setup(false)
    expect(t.out).toEqual([])
    expect(mouseReportingActive()).toBe(false)
    t.setMouse(true)
    expect(t.out).toEqual([ENABLE_MOUSE])
    expect(mouseReportingActive()).toBe(true)
    t.setMouse(false)
    expect(t.out).toEqual([ENABLE_MOUSE, DISABLE_MOUSE])
    expect(mouseReportingActive()).toBe(false)
  })

  test('starting with the setting on enables once', () => {
    const t = setup(true)
    t.store.set({ filter: 'x' })
    t.store.set((s) => ({ settings: { ...s.settings, theme: 'light' } }))
    expect(t.out).toEqual([ENABLE_MOUSE])
  })

  test('reports are emitted only while enabled', () => {
    const t = setup(false)
    t.send(click)
    expect(t.events).toEqual([])
    t.setMouse(true)
    t.send(click)
    expect(t.events).toHaveLength(1)
    expect(t.events[0]).toMatchObject({ kind: 'down', button: 'left', x: 9, y: 4 })
    t.setMouse(false)
    t.send(click)
    expect(t.events).toHaveLength(1)
  })

  test('disabling drops a half-read report', () => {
    const t = setup(true)
    t.send('\x1b[<0;1')
    t.setMouse(false)
    t.setMouse(true)
    t.send('0;5M')
    expect(t.events).toEqual([])
  })

  test('a string chunk and a Buffer chunk both parse', () => {
    const t = setup(true)
    t.send(click)
    t.send(Buffer.from(click))
    expect(t.events).toHaveLength(2)
    expect(t.events[0]).toEqual(t.events[1]!)
  })

  test('stop disables only when active, unsubscribes and is idempotent', () => {
    const off = setup(false)
    off.handle.stop()
    expect(off.out).toEqual([])
    off.setMouse(true)
    expect(off.out).toEqual([])

    const t = setup(true)
    t.handle.stop()
    t.handle.stop()
    expect(t.out).toEqual([ENABLE_MOUSE, DISABLE_MOUSE])
    expect(mouseReportingActive()).toBe(false)
    t.setMouse(false)
    t.setMouse(true)
    t.send(click)
    expect(t.out).toEqual([ENABLE_MOUSE, DISABLE_MOUSE])
    expect(t.events).toEqual([])
  })

  test('not a terminal: nothing is written, whatever the setting', () => {
    const t = setup(true, false)
    t.setMouse(false)
    t.setMouse(true)
    t.send(click)
    expect(t.out).toEqual([])
    expect(t.events).toEqual([])
  })

  test('exit and signal handlers exist only while reporting has been on', () => {
    const count = () =>
      ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'].map((e) => process.listenerCount(e as 'exit'))
    const before = count()
    const t = setup(false)
    expect(count()).toEqual(before)
    t.setMouse(true)
    expect(count()).toEqual(before.map((n) => n + 1))
    t.handle.stop()
    expect(count()).toEqual(before)
  })
})

// The real process ends: run the tracker in a child whose stdout is the
// pipe we read, next to a mounted Ink app (whose signal-exit hook must still
// unmount it), and end it the way a fatal path or a signal would.
describe('reporting is switched off when the process ends', () => {
  const root = join(import.meta.dir, '..', '..')
  function runChild(end: string) {
    const code = `
      import { writeSync } from 'node:fs'
      import { EventEmitter } from 'node:events'
      import { PassThrough } from 'node:stream'
      import { createElement, useLayoutEffect } from 'react'
      import { render, Text } from 'ink'
      import { createAppStore } from './src/state/store'
      import { startMouseTracker } from './src/ui/mouseTracker'
      const out = (s) => void writeSync(1, s)
      function Probe() {
        useLayoutEffect(() => () => out('<unmounted>'), [])
        return createElement(Text, null, 'x')
      }
      const inkOut = Object.assign(new PassThrough(), { columns: 80, rows: 24 })
      render(createElement(Probe), {
        stdout: inkOut, stdin: new PassThrough(), debug: true, patchConsole: false, exitOnCtrlC: false,
      })
      const store = createAppStore()
      store.set((s) => ({ settings: { ...s.settings, mouse: true } }))
      const stdin = Object.assign(new EventEmitter(), { isTTY: true })
      startMouseTracker(store, { stdin, stdout: { isTTY: true, fd: 1, write: out } })
      setInterval(() => {}, 1000)
      setTimeout(() => { ${end} }, 50)
    `
    const r = Bun.spawnSync(['bun', '-e', code], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    return {
      out: r.stdout.toString(),
      stderr: r.stderr.toString(),
      code: r.exitCode,
      signal: r.signalCode,
    }
  }
  const disabledLast = (out: string) =>
    out.includes(ENABLE_MOUSE) && out.lastIndexOf(DISABLE_MOUSE) > out.lastIndexOf(ENABLE_MOUSE)

  for (const code of [1, 3]) {
    test(`process.exit(${code})`, () => {
      const r = runChild(`process.exit(${code})`)
      expect(r.stderr).toBe('')
      expect(disabledLast(r.out)).toBe(true)
      expect(r.code).toBe(code)
    })
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    test(`${signal}: disabled, Ink unmounted, and the signal still ends the process`, () => {
      const r = runChild(`process.kill(process.pid, '${signal}')`)
      expect(disabledLast(r.out)).toBe(true)
      expect(r.out).toContain('<unmounted>')
      expect(r.signal).toBe(signal)
    })
  }
})
