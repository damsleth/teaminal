// DEC focus reporting (CSI ?1004) → store.terminalFocused.
//
// Modern terminals (iTerm2, kitty, alacritty, Apple Terminal,
// Windows Terminal, gnome-terminal, WezTerm, foot, …) emit ESC[I when
// they gain input focus and ESC[O when they lose it, but only after
// the host enables the mode by writing ESC[?1004h. We turn it on once
// at startup, watch raw stdin for the two sequences, and turn it off
// on shutdown so the terminal does not keep emitting them after exit.
//
// We attach our own 'data' listener; Ink's input parser is unaffected
// because it ignores these sequences (they are not standard cursor
// keys). Terminals that do not support 1004 simply never emit ESC[I/O
// and we stay on the optimistic default (focused = true). After
// DEC_FALLBACK_MS without any focus event, we mark focusReportingHealthy
// as false and stop trusting subsequent DEC sequences — better to over-
// detect focus (presence stays Available while the user is elsewhere)
// than to leave a forceAvailableWhenFocused user stuck at Away forever.
//
// Default to focused on startup: the user just launched teaminal, so
// it is overwhelmingly likely the terminal has focus right now.
//
// No exit handler beyond the returned `stop()` callback. The bin entry
// already orchestrates clean shutdown around ink.unmount() / process
// exit, and double-writing the disable sequence is harmless.
import type { AppState, Store } from '../state/store'
import { isDebugEnabled, recordEvent } from '../log'

const ENABLE = '\x1b[?1004h'
const DISABLE = '\x1b[?1004l'
const FOCUS_IN = Buffer.from('\x1b[I')
const FOCUS_OUT = Buffer.from('\x1b[O')

// Time to wait for the first DEC 1004 event before assuming the
// terminal does not support focus reporting.
const DEC_FALLBACK_MS = 5_000

export type FocusTrackerHandle = {
  stop: () => void
}

export type StartFocusTrackerOpts = {
  // Override for tests; production uses the global setTimeout.
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  fallbackMs?: number
}

export function startFocusTracker(
  store: Store<AppState>,
  opts?: StartFocusTrackerOpts,
): FocusTrackerHandle {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    return { stop() {} }
  }
  try {
    process.stdout.write(ENABLE)
  } catch {
    return { stop() {} }
  }
  // Optimistic default — user just launched us.
  if (store.get().terminalFocused !== true) {
    store.set({ terminalFocused: true })
  }

  let everSawEvent = false
  let healthy = true // optimistic; flipped to false by fallback if no events arrive

  const setTimer = opts?.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
  const clearTimer = opts?.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const fallbackMs = opts?.fallbackMs ?? DEC_FALLBACK_MS

  const fallbackTimer = setTimer(() => {
    if (everSawEvent) return
    healthy = false
    // Re-affirm focused=true in case something else flipped it, and
    // expose the diagnostic flag.
    store.set({ terminalFocused: true, focusReportingHealthy: false })
    if (isDebugEnabled()) {
      recordEvent(
        'ui',
        'debug',
        `focus reporting: no DEC 1004 events within ${fallbackMs}ms — assuming focused`,
      )
    }
  }, fallbackMs)

  const onData = (buf: Buffer): void => {
    // Sequences may arrive batched with normal keystrokes; scan rather
    // than equality-compare. Both states can appear in the same chunk
    // (e.g. focus-out immediately followed by focus-in if the user
    // alt-tabs through us); apply in order so the final state wins.
    const inIdx = buf.indexOf(FOCUS_IN)
    const outIdx = buf.indexOf(FOCUS_OUT)
    if (inIdx === -1 && outIdx === -1) return
    // Terminal has demonstrated DEC 1004 capability — record health and
    // start trusting the sequences.
    if (!everSawEvent) {
      everSawEvent = true
      healthy = true
      if (!store.get().focusReportingHealthy) {
        store.set({ focusReportingHealthy: true })
      }
      if (isDebugEnabled()) {
        recordEvent('ui', 'debug', 'focus reporting: first DEC 1004 event observed')
      }
    }
    // If we previously decided the terminal was broken, ignore late events
    // so we don't toggle back into a stuck-Away state.
    if (!healthy) return
    let next: boolean | null = null
    if (inIdx !== -1 && outIdx !== -1) next = inIdx > outIdx
    else if (inIdx !== -1) next = true
    else next = false
    if (next !== null && store.get().terminalFocused !== next) {
      store.set({ terminalFocused: next })
      if (isDebugEnabled()) {
        recordEvent('ui', 'debug', `focus reporting: focused=${next}`)
      }
    }
  }
  process.stdin.on('data', onData)

  let stopped = false
  return {
    stop() {
      if (stopped) return
      stopped = true
      clearTimer(fallbackTimer)
      process.stdin.off('data', onData)
      try {
        process.stdout.write(DISABLE)
      } catch {
        // Stream may already be closed during shutdown — nothing to do.
      }
    },
  }
}
