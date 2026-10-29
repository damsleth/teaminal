// Ink's Text with theme.text as the default color, so help lines, headers and
// other uncolored text follow the theme instead of the terminal's foreground.
// A nested Text without a color keeps inheriting its parent's, as in Ink.

import { Text as InkText, type TextProps } from 'ink'
import { createContext, useContext } from 'react'

// Provided by StoreProvider from the active theme; undefined = terminal default.
export const TextColorContext = createContext<string | undefined>(undefined)
const NestedContext = createContext(false)

export function Text(props: TextProps) {
  const defaultColor = useContext(TextColorContext)
  const nested = useContext(NestedContext)
  const color = props.color ?? (nested ? undefined : defaultColor)
  return (
    <NestedContext.Provider value={true}>
      <InkText {...props} color={color} />
    </NestedContext.Provider>
  )
}
