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
import type { AccountId, AccountRef } from '../account'
import type { GraphClient } from '../graph/client'

export type SessionApi = {
  /** Current owa-piggy profile alias, or null for the default. */
  getActiveProfile: () => string | null
  /**
   * Graph client bound to the active account. One-shot UI actions call this
   * at the moment they run, so an action never borrows another account.
   */
  client: () => GraphClient
  /** Manual push reconnect (diagnostics `r`) for `id`, default the foreground. */
  retryRealtime: (id?: AccountId) => void
  /**
   * Tear down the running session, reset account-scoped state, hydrate
   * the new profile's message cache, and bring up a new session against
   * `profile`. Throws if the new bootstrap fails (e.g. the new
   * profile's token is unauthorized); the caller should leave the UI
   * mounted with conn=offline so the user can pick a different account.
   * Concurrent mode: an instant foreground swap (starting the account
   * first if it has no session); throws when that start fails.
   */
  switchAccount: (profile: string | null) => Promise<void>
  /** Concurrent mode is on (latched at startup). Absent = single mode. */
  concurrent?: boolean
  // Concurrent mode (concurrentAccounts) only; no-ops in single mode.
  /** Start added accounts and stop removed ones after `settings.accounts` changed. */
  reconcile: () => Promise<void>
  /**
   * Swap an open account to the foreground at once. restoreUi: false keeps
   * the list cursor and filter and leaves focus on the list.
   */
  setForeground: (profile: string, opts?: { restoreUi?: boolean }) => void
  /** Start an account again that has no session (failed start). */
  retry: (profile: string) => Promise<void>
  /** Accounts with a running session, in configured order. */
  running: () => AccountRef[]
  /** Graph client bound to any open account. */
  clientFor: (id: AccountId) => GraphClient
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
