// Ink's Text with theme.text as the default color, so help lines, headers and
// other uncolored text follow the theme instead of the terminal's foreground.
// `muted` takes theme.mutedText. A nested Text without a color keeps
// inheriting its parent's, as in Ink.

import { Text as InkText, type TextProps } from 'ink'
import { createContext, useContext } from 'react'
import type { Theme } from './theme'

// Provided by StoreProvider; null = terminal default colors.
export const TextThemeContext = createContext<Pick<Theme, 'text' | 'mutedText'> | null>(null)
const NestedContext = createContext(false)

export function Text({ muted, ...props }: TextProps & { muted?: boolean }) {
  const theme = useContext(TextThemeContext)
  const nested = useContext(NestedContext)
  const color =
    props.color ?? (muted ? (theme?.mutedText ?? 'gray') : nested ? undefined : theme?.text)
  return (
    <NestedContext.Provider value={true}>
      <InkText {...props} color={color} />
    </NestedContext.Provider>
  )
}
