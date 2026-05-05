// React context for switching the active owa-piggy profile at runtime.
//
// Held as an object passed by reference: the CLI bootstrap mutates
// nothing, but components that need to read the current profile or
// initiate a switch get a stable function via useSessionApi.
//
// The switch flow lives in bin/teaminal.tsx (because it owns the
// session ref + cache path) and is exposed here as `switchAccount`.

import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'

export type SessionApi = {
  /** Current owa-piggy profile alias, or null for the default. */
  getActiveProfile: () => string | null
  /**
   * Tear down the running session, reset account-scoped state, hydrate
   * the new profile's message cache, and bring up a new session against
   * `profile`. Throws if the new bootstrap fails (e.g. the new
   * profile's token is unauthorized); the caller should leave the UI
   * mounted with conn=offline so the user can pick a different account.
   */
  switchAccount: (profile: string | null) => Promise<void>
}

const SessionContext = createContext<SessionApi | null>(null)

export function SessionProvider(props: { api: SessionApi; children: ReactNode }) {
  return <SessionContext.Provider value={props.api}>{props.children}</SessionContext.Provider>
}

export function useSessionApi(): SessionApi {
  const api = useContext(SessionContext)
  if (!api) throw new Error('useSessionApi must be used inside <SessionProvider>')
  return api
}
