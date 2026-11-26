// Keeps an active Desktop endpoint registered and forces the picked
// presence (default Available) on presence.teams.microsoft.com while the
// terminal window has focus, mimicking the desktop client's "I am active,
// mark me Available" behavior. A non-Available pick is held while blurred.
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
//   - 401/403/404 from the endpoint: mark unreachable for this driver's
//     account (same pattern as the read-side teamsPresenceUnreachable
//     flag in the poller). Never log access tokens.
//
// One driver per account session: it owns its endpoint id and latch, reads
// the global presence choice / focus / settings through its account's
// handle and stops reacting once that handle is stale.
//   - 5xx / network: warn once and try again on the next refresh tick.
//   - Aborts during shutdown are silent.

import { owaProfile } from '../account'
import { forceMyAvailability, registerMyEndpoint, TeamsPresenceError } from '../graph/teamsPresence'
import { warn } from '../log'
import type { Presence } from '../types'
import type { AccountStore, AccountView } from './accountStore'

// Refresh well inside the server-side ~5 minute expiry. Four minutes
// gives one full retry window if a single PUT fails.
const REFRESH_MS = 4 * 60 * 1000

export type ForceAvailabilityHandle = {
  stop: () => void
  // Put presence back to Available when the user had picked something else.
  // Call before stop(); bounded by a short timeout so quitting never hangs.
  reset: () => Promise<void>
}

export function startForceAvailabilityDriver(acc: AccountStore): ForceAvailabilityHandle {
  const profile = owaProfile(acc.ref)
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: AbortController | null = null
  let unreachable = false
  let stopped = false
  // One endpoint id per run: re-registering the same id keeps it alive.
  const endpointId = crypto.randomUUID()

  const cancelTimer = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const fire = async (): Promise<void> => {
    if (stopped || unreachable) return
    if (!shouldFire(acc.get())) return
    inFlight?.abort()
    inFlight = new AbortController()
    const signal = inFlight.signal
    try {
      // forceavailability is ignored unless an endpoint of ours is active.
      await registerMyEndpoint(endpointId, { profile, signal })
      const choice = acc.get().presenceChoice
      await forceMyAvailability(choice, { profile, signal })
      // Show it now; the presence poll (~60s) would otherwise lag the header.
      if (!signal.aborted) mirrorPresence(acc, choice)
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
        if (!stopped && !unreachable && shouldFire(acc.get())) schedule()
      })
    }, REFRESH_MS)
  }

  let prevOn = false
  let prevChoice = acc.get().presenceChoice
  const handle = (s: AccountView): void => {
    const isOn = shouldFire(s)
    const choiceChanged = s.presenceChoice !== prevChoice
    prevChoice = s.presenceChoice
    if (isOn && (!prevOn || choiceChanged)) {
      void fire()
      schedule()
    } else if (!isOn && prevOn) {
      cancelTimer()
      inFlight?.abort()
    }
    prevOn = isOn
  }

  // Bootstrap with current state before subscribing so the initial
  // focused-on-launch case (and a freshly started account) fires exactly once.
  handle(acc.get())
  const unsub = acc.subscribe(handle)

  return {
    async reset() {
      if (unreachable || acc.get().presenceChoice === 'Available') return
      try {
        await forceMyAvailability('Available', {
          profile,
          signal: AbortSignal.timeout(3000),
        })
      } catch (err) {
        warn('forceavailability reset:', err instanceof Error ? err.message : String(err))
      }
    },
    stop() {
      if (stopped) return
      stopped = true
      unsub()
      cancelTimer()
      inFlight?.abort()
    },
  }
}

function shouldFire(s: AccountView): boolean {
  // A picked presence (Busy, DND, ...) is held regardless of focus or the
  // setting; only plain Available follows them.
  if (s.presenceChoice !== 'Available') return true
  if (s.settings.forceAvailableWhenFocused === false) return false
  if (s.terminalFocused === false) return false
  return true
}

function mirrorPresence(acc: AccountStore, choice: Presence['availability']): void {
  acc.set((s) => ({
    myPresence: {
      id: s.me?.id ?? s.myPresence?.id ?? '',
      ...s.myPresence,
      availability: choice,
      activity: choice,
    },
  }))
}
