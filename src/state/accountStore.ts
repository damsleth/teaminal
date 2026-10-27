// Account-scoped view of the app store (M2 Phase D).
//
// Session code (bootstrap, poller, bridge, actions) takes one of these
// instead of the whole Store<AppState>, so it can only write the fields its
// account owns. The handle captures (account id, generation) when created:
// once the store is reset for another account — or for a fresh incarnation
// of the same one — every write through it is dropped and its listeners stop
// firing. Nothing is ever created for a stale handle.
//
// Contract:
//   get()        current state: the account's fields plus read-only global
//                UI/environment state (focus, settings, terminalFocused, ...).
//   set(patch)   account fields only; other keys are ignored. Returns false
//                and does nothing when the handle is stale.
//   subscribe(l) fires only when one of the account's fields changed, and
//                only while the handle is current.
//   isCurrent()  true while the store still belongs to this incarnation.
//
// Global UI/environment writes go through the Store itself, explicitly.
//
// ponytail: one account per store, so get() returns the flat AppState. With
// concurrent accounts (Phase E) the flat fields stay the *foreground*
// account's and background accounts get a side map; this handle routes each
// write to wherever its account lives, so callers don't change. Focus and
// modal payloads carry no account id because they always belong to
// store.account: a foreground switch must save/restore or close them.

import type { AccountRef } from '../account'
import { ACCOUNT_KEYS, type AccountSlice, type AppState, type GlobalKey, type Store } from './store'

export type AccountView = Readonly<AppState>
// Global keys are typed `never` so an updater that returns one fails to
// compile (TS skips excess-property checks on function results).
export type AccountPatch = Partial<AccountSlice> & Partial<Record<GlobalKey, never>>

export type AccountStore = {
  readonly ref: AccountRef
  readonly generation: number
  isCurrent(): boolean
  get(): AccountView
  set(input: AccountPatch | ((s: AccountView) => AccountPatch)): boolean
  subscribe(listener: (s: AccountView) => void): () => void
}

// Binds to the store's current account and generation. Throws when the store
// has no account yet: a handle must never adopt whichever account comes next.
export function accountStore(store: Store<AppState>): AccountStore {
  const { account: ref, accountGeneration: generation } = store.get()
  if (!ref) throw new Error('accountStore: store has no account')
  const isCurrent = () => {
    const s = store.get()
    return s.accountGeneration === generation && s.account?.id === ref.id
  }
  return {
    ref,
    generation,
    isCurrent,
    get: () => store.get(),
    set(input) {
      if (!isCurrent()) return false
      const patch = typeof input === 'function' ? input(store.get()) : input
      const scoped: AccountPatch = {}
      for (const k of ACCOUNT_KEYS) {
        if (k in patch) (scoped as Record<string, unknown>)[k] = patch[k]
      }
      store.set(scoped)
      return true
    },
    subscribe(listener) {
      let prev = store.get()
      return store.subscribe((s) => {
        const before = prev
        prev = s
        if (!isCurrent()) return
        if (ACCOUNT_KEYS.some((k) => s[k] !== before[k])) listener(s)
      })
    },
  }
}
