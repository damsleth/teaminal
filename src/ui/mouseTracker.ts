// SGR mouse reporting (modes 1000 + 1006), switched by settings.mouse.
//
// Off by default: with reporting on, a plain drag goes to the app instead of
// selecting text in the terminal. While the setting is off nothing is
// written to the terminal and no handler is installed.
//
// Like focusTracker, this watches raw stdin with its own 'data' listener
// (never pausing it, AGENTS.md pitfall 10) and hands decoded events to the
// onMouse listeners; the useInput wrapper keeps the same reports out of the
// key handlers.
//
// Reporting left on after exit makes every click in the shell type escape
// sequences, so it is switched off on every way out we can see: stop() on a
// clean quit, the process 'exit' event (process.exit on the fatal paths),
// SIGINT / SIGTERM / SIGHUP, and the editor handoff (suspendMouseReporting).
// SIGKILL and a lost terminal cannot be covered; the README has the reset.

import { writeSync } from 'node:fs'
import { warn } from '../log'
import type { AppState, Store } from '../state/store'
import { createMouseParser, DISABLE_MOUSE, ENABLE_MOUSE, type MouseEvent } from './mouse'

export type MouseIO = {
  stdin: Pick<NodeJS.ReadStream, 'isTTY' | 'on' | 'off'>
  stdout: { isTTY?: boolean; fd?: number; write(s: string): unknown }
}

export type MouseTrackerHandle = { stop: () => void }

type Tracker = { active: () => boolean; suspend: () => () => void }

const listeners = new Set<(event: MouseEvent) => void>()
let current: Tracker | null = null

export function onMouse(listener: (event: MouseEvent) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// Reporting is on in the terminal right now.
export function mouseReportingActive(): boolean {
  return current?.active() ?? false
}

// Hand the terminal to another program (the editor): reporting off and
// parsing stopped. The returned function restores it, unless the setting
// went off or the tracker stopped meanwhile.
export function suspendMouseReporting(): () => void {
  return current ? current.suspend() : () => {}
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

export function startMouseTracker(
  store: Store<AppState>,
  io: MouseIO = { stdin: process.stdin, stdout: process.stdout },
): MouseTrackerHandle {
  if (!io.stdout.isTTY || !io.stdin.isTTY) return { stop() {} }
  const parser = createMouseParser()
  let want = store.get().settings.mouse
  let on = false // ENABLE_MOUSE written and not undone
  let suspended = false
  let stopped = false
  let hooked = false

  // Live toggles go through the stream, in order with Ink's frames. On the
  // way out the write is synchronous: queued output may never be flushed.
  const write = (seq: string, now = false) => {
    try {
      if (now && typeof io.stdout.fd === 'number') writeSync(io.stdout.fd, seq)
      else io.stdout.write(seq)
    } catch {
      // Terminal already gone: nothing left to restore.
    }
  }
  const enable = () => {
    if (on || suspended || stopped) return
    hook()
    parser.reset()
    write(ENABLE_MOUSE)
    on = true
  }
  const disable = (now = false) => {
    parser.reset()
    if (!on) return
    on = false
    write(DISABLE_MOUSE, now)
  }

  // A signal listener of our own keeps the signal from killing the process:
  // Ink's signal-exit hook only unmounts and re-raises when it is the sole
  // listener. So switch reporting off, step aside and re-raise; the signal
  // then ends the process the way it would have without us (and under
  // `bun --watch` the dev-mode SIGTERM no-op still keeps it alive).
  const onExit = () => disable(true)
  const onSignal = SIGNALS.map((signal) => {
    const handler = () => {
      disable(true)
      unhook()
      process.kill(process.pid, signal)
    }
    return [signal, handler] as const
  })
  // Installed on first enable, so a run with the setting off adds nothing.
  function hook() {
    if (hooked) return
    hooked = true
    process.on('exit', onExit)
    for (const [signal, handler] of onSignal) process.on(signal, handler)
  }
  function unhook() {
    if (!hooked) return
    hooked = false
    process.off('exit', onExit)
    for (const [signal, handler] of onSignal) process.off(signal, handler)
  }

  const unsubscribe = store.subscribe((s) => {
    if (s.settings.mouse === want) return
    want = s.settings.mouse
    if (want) enable()
    else disable()
  })
  const onData = (chunk: string | Buffer) => {
    if (!on) return
    for (const event of parser.push(chunk)) {
      for (const listener of [...listeners]) {
        try {
          listener(event)
        } catch (err) {
          warn('mouse: handler failed:', err instanceof Error ? err.message : String(err))
        }
      }
    }
  }
  io.stdin.on('data', onData)

  const tracker: Tracker = {
    active: () => on,
    suspend() {
      if (stopped || suspended) return () => {}
      suspended = true
      disable()
      return () => {
        suspended = false
        parser.reset()
        if (want) enable()
      }
    },
  }
  current = tracker
  if (want) enable()

  return {
    stop() {
      if (stopped) return
      stopped = true
      unsubscribe()
      io.stdin.off('data', onData)
      disable(true)
      unhook()
      if (current === tracker) current = null
    },
  }
}
