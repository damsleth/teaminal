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
  const systemAppearance = useAppState((s) => s.systemAppearance)
  return cachedTheme(settings, activeCustomThemeData(settings.theme, customTheme), systemAppearance)
}

// The last resolved theme and what it was resolved from. Every component
// calls useTheme, so resolving once per change (not per render per
// component) also keeps the theme object stable for memo / effect deps.
let lastTheme: { inputs: unknown[]; theme: Theme } | null = null

function cachedTheme(
  settings: AppState['settings'],
  custom: PartialTheme | null,
  appearance: AppState['systemAppearance'],
): Theme {
  // Exactly the settings resolveTheme reads.
  const inputs = [
    settings.theme,
    settings.themeOverrides,
    settings.messageFocusIndicatorColor,
    settings.messageFocusBackgroundColor,
    custom,
    appearance,
  ]
  if (lastTheme && lastTheme.inputs.every((v, i) => v === inputs[i])) return lastTheme.theme
  const theme = resolveTheme(settings, custom, appearance)
  lastTheme = { inputs, theme }
  return theme
}

export function activeCustomThemeData(
  themeName: string,
  customTheme: AppState['customTheme'],
): PartialTheme | null {
  return customTheme && customTheme.name === themeName ? (customTheme.data as PartialTheme) : null
}
