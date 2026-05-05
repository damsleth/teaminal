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
// and we stay on the optimistic default (focused = true), which is
// fine — the worst case is the force-availability driver behaves as if
// the terminal were always focused.
//
// Default to focused on startup: the user just launched teaminal, so
// it is overwhelmingly likely the terminal has focus right now.
//
// No exit handler beyond the returned `stop()` callback. The bin entry
// already orchestrates clean shutdown around ink.unmount() / process
// exit, and double-writing the disable sequence is harmless.
import type { AppState, Store } from '../state/store'

const ENABLE = '\x1b[?1004h'
const DISABLE = '\x1b[?1004l'
const FOCUS_IN = Buffer.from('\x1b[I')
const FOCUS_OUT = Buffer.from('\x1b[O')

export type FocusTrackerHandle = {
  stop: () => void
}

export function startFocusTracker(store: Store<AppState>): FocusTrackerHandle {
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

  const onData = (buf: Buffer): void => {
    // Sequences may arrive batched with normal keystrokes; scan rather
    // than equality-compare. Both states can appear in the same chunk
    // (e.g. focus-out immediately followed by focus-in if the user
    // alt-tabs through us); apply in order so the final state wins.
    const inIdx = buf.indexOf(FOCUS_IN)
    const outIdx = buf.indexOf(FOCUS_OUT)
    if (inIdx === -1 && outIdx === -1) return
    let next: boolean | null = null
    if (inIdx !== -1 && outIdx !== -1) next = inIdx > outIdx
    else if (inIdx !== -1) next = true
    else next = false
    if (next !== null && store.get().terminalFocused !== next) {
      store.set({ terminalFocused: next })
    }
  }
  process.stdin.on('data', onData)

  let stopped = false
  return {
    stop() {
      if (stopped) return
      stopped = true
      process.stdin.off('data', onData)
      try {
        process.stdout.write(DISABLE)
      } catch {
        // Stream may already be closed during shutdown — nothing to do.
      }
    },
  }
}
