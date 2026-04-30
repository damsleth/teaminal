// React glue for the pub/sub Store.
//
// useAppState is a selector hook over useSyncExternalStore - components only
// re-render when the selected slice actually changes (since Store.set skips
// listener notifications on no-op updates).

import { createContext, useContext, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { AppState, Store } from '../state/store'
import { getTheme, type Theme } from './theme'

const StoreContext = createContext<Store<AppState> | null>(null)

export function StoreProvider(props: {
  store: Store<AppState>
  children: ReactNode
}) {
  return <StoreContext.Provider value={props.store}>{props.children}</StoreContext.Provider>
}

export function useAppStore(): Store<AppState> {
  const s = useContext(StoreContext)
  if (!s) throw new Error('useAppStore must be used inside <StoreProvider>')
  return s
}

export function useAppState<T>(selector: (s: AppState) => T): T {
  const store = useAppStore()
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => selector(store.get()),
    () => selector(store.get()),
  )
}

// Active palette derived from settings.theme. Subscribes only to the
// theme slice so toggling other settings does not re-render every Themed
// component.
export function useTheme(): Theme {
  const mode = useAppState((s) => s.settings.theme)
  return getTheme(mode)
}
