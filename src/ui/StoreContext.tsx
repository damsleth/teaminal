// React glue for the pub/sub Store.
//
// useAppState is a selector hook over useSyncExternalStore - components only
// re-render when the selected slice actually changes (since Store.set skips
// listener notifications on no-op updates).

import { createContext, useContext, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { AppState, Store } from '../state/store'
import { resolveTheme, type PartialTheme, type Theme } from './theme'

const StoreContext = createContext<Store<AppState> | null>(null)

export function StoreProvider(props: { store: Store<AppState>; children: ReactNode }) {
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

// Active palette derived from settings + any loaded custom theme.
// Custom theme JSON is loaded once at startup by bin/teaminal.tsx and
// stored on AppState.customTheme; settings.themeOverrides still wins.
export function useTheme(): Theme {
  const settings = useAppState((s) => s.settings)
  const customTheme = useAppState((s) => s.customTheme)
  return resolveTheme(settings, activeCustomThemeData(settings.theme, customTheme))
}

export function activeCustomThemeData(
  themeName: string,
  customTheme: AppState['customTheme'],
): PartialTheme | null {
  return customTheme && customTheme.name === themeName ? (customTheme.data as PartialTheme) : null
}
