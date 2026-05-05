// Drives presence.teams.microsoft.com /v1/me/forceavailability/ while the
// terminal window has focus, mimicking the desktop client's "I am
// active, mark me Available" behavior.
//
// Lifecycle:
//   - Subscribes to the store. When (terminalFocused && setting on)
//     transitions from off → on, immediately PUTs Available.
//   - While that condition holds, refreshes every REFRESH_MS so the
//     server-side ~5min override never expires.
//   - On off transition, stops the timer. We deliberately do *not*
//     issue a clearing call — restoring auto-presence would require
//     guessing the user's "real" state, which we do not own.
//
// Failure modes:
//   - 401/403/404 from the endpoint: mark unreachable for the whole
//     session (same pattern as the read-side teamsPresenceUnreachable
//     flag in the poller). Never log access tokens.
//   - 5xx / network: warn once and try again on the next refresh tick.
//   - Aborts during shutdown are silent.

import { getActiveProfile } from '../graph/client'
import { forceMyAvailability, TeamsPresenceError } from '../graph/teamsPresence'
import { warn } from '../log'
import type { AppState, Store } from './store'

// Refresh well inside the server-side ~5 minute expiry. Four minutes
// gives one full retry window if a single PUT fails.
const REFRESH_MS = 4 * 60 * 1000

export type ForceAvailabilityHandle = {
  stop: () => void
}

export function startForceAvailabilityDriver(store: Store<AppState>): ForceAvailabilityHandle {
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: AbortController | null = null
  let unreachable = false
  let stopped = false

  const cancelTimer = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const fire = async (): Promise<void> => {
    if (stopped || unreachable) return
    if (!shouldFire(store.get())) return
    inFlight?.abort()
    inFlight = new AbortController()
    const signal = inFlight.signal
    try {
      await forceMyAvailability('Available', { profile: getActiveProfile(), signal })
    } catch (err) {
      if (signal.aborted) return
      if (err instanceof Error && /abort/i.test(err.message)) return
      if (
        err instanceof TeamsPresenceError &&
        (err.status === 401 || err.status === 403 || err.status === 404)
      ) {
        unreachable = true
        warn('forceavailability disabled for session:', err.message)
        cancelTimer()
        return
      }
      warn('forceavailability:', err instanceof Error ? err.message : String(err))
    } finally {
      if (inFlight && inFlight.signal === signal) inFlight = null
    }
  }

  const schedule = (): void => {
    cancelTimer()
    if (stopped || unreachable) return
    timer = setTimeout(() => {
      void fire().finally(() => {
        if (!stopped && !unreachable && shouldFire(store.get())) schedule()
      })
    }, REFRESH_MS)
  }

  let prevOn = false
  const handle = (s: AppState): void => {
    const isOn = shouldFire(s)
    if (isOn && !prevOn) {
      void fire()
      schedule()
    } else if (!isOn && prevOn) {
      cancelTimer()
      inFlight?.abort()
    }
    prevOn = isOn
  }

  // Bootstrap with current state before subscribing so the initial
  // focused-on-launch case fires exactly once.
  handle(store.get())
  const unsub = store.subscribe(handle)

  return {
    stop() {
      if (stopped) return
      stopped = true
      unsub()
      cancelTimer()
      inFlight?.abort()
    },
  }
}

function shouldFire(s: AppState): boolean {
  if (s.settings.forceAvailableWhenFocused === false) return false
  if (s.terminalFocused === false) return false
  return true
}
