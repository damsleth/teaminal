// Account-scoped view of the app store (M2 Phase D, slots since E.2).
//
// Session code (bootstrap, poller, bridge, actions) takes one of these
// instead of the whole Store<AppState>, so it can only write the fields its
// account owns. The handle captures (account id, generation) when created:
// once its account slot is closed or re-opened, every write through it is
// dropped and its listeners stop firing. Nothing is ever created for a
// stale handle.
//
// The store holds N account slots. The flat account fields are the
// foreground account's; the others live in backgroundAccounts. A handle
// routes reads and writes to wherever its account lives, so it keeps
// following its account across a foreground swap.
//
// Contract:
//   get()          foreground: the root state. Background: the root state with
//                  the account's slice over the flat fields and the Global-UI
//                  group reset (list focus, no modal/filter/search), so session
//                  code never sees the foreground's focus. Stale: the same shape
//                  with an empty slice.
//   set(patch)     account fields only; other keys are ignored. Returns false
//                  and does nothing when the handle is stale.
//   subscribe(l)   fires with get() on every store change while current.
//   isCurrent()    true while the slot keeps the captured generation.
//   isForeground() current and in the foreground.
//
// Global UI/environment writes go through the Store itself, explicitly.
// Focus and modal payloads carry no account id because they always belong to
// store.account: setForeground saves/restores focus and closes the rest.

import type { AccountId, AccountRef } from '../account'
import {
  ACCOUNT_KEYS,
  initialAccountState,
  initialAppState,
  pickAccountSlice,
  type AccountSlice,
  type AccountState,
  type AccountUi,
  type AppState,
  type Focus,
  type GlobalKey,
  type Store,
} from './store'

export type AccountView = Readonly<AppState>
// Global keys are typed `never` so an updater that returns one fails to
// compile (TS skips excess-property checks on function results).
export type AccountPatch = Partial<AccountSlice> & Partial<Record<GlobalKey, never>>

export type AccountStore = {
  readonly ref: AccountRef
  readonly generation: number
  isCurrent(): boolean
  isForeground(): boolean
  get(): AccountView
  set(input: AccountPatch | ((s: AccountView) => AccountPatch)): boolean
  subscribe(listener: (s: AccountView) => void): () => void
}

// The Global-UI group as a background or stale account sees it. The focus
// object is shared so a background view's focus keeps its identity.
const LIST_FOCUS: Focus = Object.freeze({ kind: 'list' })
const RESET_UI = {
  focus: LIST_FOCUS,
  inputZone: 'list',
  cursor: 0,
  cursorKey: null,
  focusedAttachmentIndex: 0,
  filter: '',
  messageSearchQuery: '',
  messageSearchFocusedId: null,
  modal: null,
  editingMessageId: null,
} as const satisfies Partial<AppState>

function without<V>(rec: Record<AccountId, V>, id: AccountId): Record<AccountId, V> {
  const out = { ...rec }
  delete out[id]
  return out
}

function emptySlice(): AccountSlice {
  return pickAccountSlice(initialAppState())
}

// Handle for the foreground account. Throws when the store has no account
// yet: a handle must never adopt whichever account comes next.
export function accountStore(store: Store<AppState>): AccountStore {
  const ref = store.get().account
  if (!ref) throw new Error('accountStore: store has no account')
  return accountStoreFor(store, ref)
}

// Handle for an open account slot, foreground or background.
export function accountStoreFor(store: Store<AppState>, ref: AccountRef): AccountStore {
  const generation = store.get().generationById[ref.id]
  if (generation === undefined) throw new Error(`accountStore: ${ref.label} is not open`)
  const isCurrent = () => store.get().generationById[ref.id] === generation
  const isForeground = () => isCurrent() && store.get().account?.id === ref.id
  let viewRoot: AppState | undefined
  let view: AccountView | undefined
  let empty: AccountSlice | undefined
  function get(): AccountView {
    const s = store.get()
    if (isForeground()) return s
    if (s === viewRoot) return view!
    const slice = (isCurrent() && s.backgroundAccounts[ref.id]) || (empty ??= emptySlice())
    viewRoot = s
    view = { ...s, ...pickAccountSlice(slice), account: ref, ...RESET_UI }
    return view
  }
  return {
    ref,
    generation,
    isCurrent,
    isForeground,
    get,
    set(input) {
      if (!isCurrent()) return false
      const patch = typeof input === 'function' ? input(get()) : input
      const scoped: Record<string, unknown> = {}
      for (const k of ACCOUNT_KEYS) {
        if (k in patch) scoped[k] = patch[k]
      }
      if (isForeground()) {
        store.set(scoped as AccountPatch)
        return true
      }
      // Same merge rules as Store.set: undefined is ignored, and an
      // unchanged slice is not written (no notification).
      store.set((s) => {
        const slot = s.backgroundAccounts[ref.id]
        if (!slot) return {}
        let next: AccountState | undefined
        for (const [k, v] of Object.entries(scoped)) {
          if (v !== undefined && v !== slot[k as keyof AccountState]) {
            next ??= { ...slot }
            ;(next as Record<string, unknown>)[k] = v
          }
        }
        return next ? { backgroundAccounts: { ...s.backgroundAccounts, [ref.id]: next } } : {}
      })
      return true
    },
    subscribe(listener) {
      return store.subscribe(() => {
        if (isCurrent()) listener(get())
      })
    },
  }
}

// Open a slot for `ref` with a fresh generation and empty data, in the
// foreground (the flat fields, Global-UI group reset) or the background.
// Re-opening an open id replaces it: handles on the old slot go stale.
// Opening in the foreground while another open account is there is a caller
// error (open in the background, then setForeground).
export function openAccount(
  store: Store<AppState>,
  ref: AccountRef,
  { foreground }: { foreground: boolean },
): AccountStore {
  const s = store.get()
  const isForeground = s.account?.id === ref.id
  if (foreground && s.account && !isForeground && s.generationById[s.account.id] !== undefined) {
    throw new Error('openAccount: another account is in the foreground')
  }
  if (!foreground && isForeground) {
    throw new Error('openAccount: cannot re-open the foreground account in the background')
  }
  const generation = s.accountGeneration + 1
  const generationById = { ...s.generationById, [ref.id]: generation }
  const uiByAccount = without(s.uiByAccount, ref.id)
  const fresh = initialAccountState(ref)
  if (foreground) {
    store.replace({
      ...s,
      ...pickAccountSlice(fresh),
      ...RESET_UI,
      focus: { kind: 'list' },
      account: ref,
      accountGeneration: generation,
      generationById,
      backgroundAccounts: without(s.backgroundAccounts, ref.id),
      uiByAccount,
    })
  } else {
    store.replace({
      ...s,
      accountGeneration: generation,
      generationById,
      backgroundAccounts: { ...s.backgroundAccounts, [ref.id]: fresh },
      uiByAccount,
    })
  }
  return accountStoreFor(store, ref)
}

// Remove a slot, its generation and its saved UI; its handles go stale.
// Closing the foreground while other slots are open is a caller error (swap
// first); closing the last one empties the flat account fields, resets the
// Global-UI group and sets account: null. No-op for an id that is not open.
export function closeAccount(store: Store<AppState>, id: AccountId): void {
  const s = store.get()
  if (s.generationById[id] === undefined) return
  const generationById = without(s.generationById, id)
  const uiByAccount = without(s.uiByAccount, id)
  if (s.account?.id === id) {
    if (Object.keys(generationById).length > 0) {
      throw new Error('closeAccount: move another account to the foreground first')
    }
    store.replace({
      ...s,
      ...emptySlice(),
      ...RESET_UI,
      focus: { kind: 'list' },
      account: null,
      generationById,
      backgroundAccounts: {},
      uiByAccount,
    })
    return
  }
  store.replace({
    ...s,
    generationById,
    backgroundAccounts: without(s.backgroundAccounts, id),
    uiByAccount,
  })
}

// Swap background account `id` into the foreground in one store update: the
// flat fields take its slice, the old foreground's slice and focus/cursor move
// to backgroundAccounts / uiByAccount, the target's saved focus/cursor come
// back (default: list, cursor 0) and the rest of the Global-UI group is
// cleared. restoreUi: false (Phase F: open a row in another account's section)
// keeps the list cursor and filter and leaves focus on the list for the caller
// to set. Generations are untouched, so every handle keeps following its
// account. No-op when `id` is already the foreground; throws when not open.
export function setForeground(
  store: Store<AppState>,
  id: AccountId,
  { restoreUi = true }: { restoreUi?: boolean } = {},
): void {
  const s = store.get()
  if (s.account?.id === id) return
  const target = s.backgroundAccounts[id]
  if (!target) throw new Error(`setForeground: account ${id} is not open`)
  const backgroundAccounts = without(s.backgroundAccounts, id)
  const uiByAccount = { ...s.uiByAccount }
  const old = s.account
  if (old && s.generationById[old.id] !== undefined) {
    backgroundAccounts[old.id] = { ...pickAccountSlice(s), ref: old }
    uiByAccount[old.id] = { focus: s.focus, cursor: s.cursor, cursorKey: s.cursorKey }
  }
  const ui: AccountUi = restoreUi
    ? (uiByAccount[id] ?? { focus: { kind: 'list' }, cursor: 0, cursorKey: null })
    : { focus: { kind: 'list' }, cursor: s.cursor, cursorKey: s.cursorKey }
  store.replace({
    ...s,
    ...pickAccountSlice(target),
    account: target.ref,
    backgroundAccounts,
    uiByAccount,
    ...ui,
    filter: restoreUi ? '' : s.filter,
    inputZone: 'list',
    modal: null,
    messageSearchQuery: '',
    messageSearchFocusedId: null,
    editingMessageId: null,
    focusedAttachmentIndex: 0,
  })
}
