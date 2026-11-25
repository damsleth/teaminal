// Diagnostics overview (M2 G): one row per open account, read from its slot.
// Pure: the Diagnostics modal renders it, tests call it directly.

import { owaProfile, type AccountRef } from '../account'
import { getListCachePath } from './listCachePersistence'
import { getMessageCachePath } from './messageCachePersistence'
import { getNameCachePath } from './nameCachePersistence'
import {
  accountSlice,
  routingForAccount,
  type AppState,
  type ChatRoutingMode,
  type ConnectionState,
  type RealtimeState,
} from './store'

type Env = Record<string, string | undefined>

export type AccountDiagnostics = {
  ref: AccountRef
  foreground: boolean
  conn: ConnectionState
  realtimeState: RealtimeState
  lastListPollAt: Date | undefined
  routing: ChatRoutingMode
  // `4/4 ok`, `3/4: presence`, or `probing` before the probe finished.
  capabilities: string
  // The account's message, list and name cache files.
  cachePaths: [string, string, string]
}

// Open accounts in configured order (an account missing from
// settings.accounts, e.g. single mode's default profile, goes last).
export function accountDiagnostics(s: AppState, env: Env = process.env): AccountDiagnostics[] {
  const refs = [
    ...(s.account ? [s.account] : []),
    ...Object.values(s.backgroundAccounts).map((a) => a.ref),
  ]
  const order = (ref: AccountRef): number => {
    const i = s.settings.accounts.indexOf(owaProfile(ref) ?? '')
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }
  return refs
    .sort((a, b) => order(a) - order(b))
    .flatMap((ref) => {
      const slice = accountSlice(s, ref.id)
      if (!slice) return []
      const profile = owaProfile(ref)
      const caps = slice.capabilities ? Object.entries(slice.capabilities) : []
      const failing = caps.filter(([, c]) => !c.ok).map(([area]) => area)
      return [
        {
          ref,
          foreground: s.account?.id === ref.id,
          conn: slice.conn,
          realtimeState: slice.realtimeState,
          lastListPollAt: slice.lastListPollAt,
          routing: routingForAccount(s.settings, profile),
          capabilities: slice.capabilities
            ? `${caps.length - failing.length}/${caps.length}${failing.length > 0 ? `: ${failing.join(', ')}` : ' ok'}`
            : 'probing',
          cachePaths: [
            getMessageCachePath(env, profile),
            getListCachePath(env, profile),
            getNameCachePath(env, profile),
          ],
        },
      ]
    })
}
