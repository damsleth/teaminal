// Detects whether the OS is in dark or light appearance, so the 'auto'
// theme can follow it.
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
  opts?: { intervalMs?: number; detect?: () => SystemAppearance },
): SystemAppearanceDriver {
  const detect = opts?.detect ?? (() => detectSystemAppearance())
  const apply = (): void => {
    const next = detect()
    if (store.get().systemAppearance !== next) store.set({ systemAppearance: next })
  }
  apply() // synchronous initial read so the first render uses the right base
  const timer = setInterval(apply, opts?.intervalMs ?? 15_000)
  if (typeof timer.unref === 'function') timer.unref()
  return {
    stop() {
      clearInterval(timer)
    },
  }
}
