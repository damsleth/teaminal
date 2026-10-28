// The appearance the 'auto' theme follows: light or dark. The terminal's
// own background (probed at startup, src/ui/terminalBackground.ts) wins;
// the OS appearance is the fallback for terminals that don't report one.
//
// After startup the OS appearance is still polled: when it flips, the
// terminal's colors usually flip with it (light/dark theme pairs), so the
// new OS value is taken from then on.
// ponytail: the terminal isn't asked again after startup (its reply would
// land in Ink's input); re-probe on focus-in if a terminal changes colors
// on its own.
//
// macOS: `defaults read -g AppleInterfaceStyle` prints "Dark" in dark mode
// and exits non-zero (the key does not exist) in light mode. Other platforms
// have no cheap, uniform probe, so they default to 'dark' (teaminal's
// historical default) — users there can still pick 'dark'/'light' explicitly.
//
// The driver polls on an interval so flipping the OS appearance updates the
// running app without a restart. Detection is a short subprocess; the poll
// interval is generous since appearance changes are rare.

import { execFileSync } from 'node:child_process'
import type { AppState, Store, SystemAppearance } from './store'

type DetectOpts = {
  platform?: NodeJS.Platform
  // Reads the raw `AppleInterfaceStyle` value; throws when the key is absent
  // (light mode). Injected in tests.
  read?: () => string
}

function defaultRead(): string {
  return execFileSync('defaults', ['read', '-g', 'AppleInterfaceStyle'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

export function detectSystemAppearance(opts?: DetectOpts): SystemAppearance {
  const platform = opts?.platform ?? process.platform
  if (platform !== 'darwin') return 'dark'
  const read = opts?.read ?? defaultRead
  try {
    return read().trim() === 'Dark' ? 'dark' : 'light'
  } catch {
    // Non-zero exit / missing key => light mode.
    return 'light'
  }
}

export type SystemAppearanceDriver = { stop: () => void }

export function startSystemAppearanceDriver(
  store: Store<AppState>,
  opts?: {
    intervalMs?: number
    detect?: () => SystemAppearance
    // The terminal background's appearance from the startup probe, if any.
    terminal?: SystemAppearance | null
  },
): SystemAppearanceDriver {
  const detect = opts?.detect ?? (() => detectSystemAppearance())
  const set = (next: SystemAppearance): void => {
    if (store.get().systemAppearance !== next) store.set({ systemAppearance: next })
  }
  // Synchronous initial read so the first render uses the right base.
  let os = detect()
  set(opts?.terminal ?? os)
  const timer = setInterval(() => {
    const next = detect()
    if (next === os) return
    os = next
    set(next)
  }, opts?.intervalMs ?? 15_000)
  if (typeof timer.unref === 'function') timer.unref()
  return {
    stop() {
      clearInterval(timer)
    },
  }
}
