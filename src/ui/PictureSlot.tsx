import { Box, Text } from 'ink'
import type { InlineImageSlots } from './inlineImageLayout'
import type { Theme } from './theme'

// Initials of a display name ("Lovelace, Ada" → "LA"), at most two.
export function initialsOf(name: string): string {
  return name
    .split(/[\s,]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => Array.from(w)[0]!.toUpperCase())
    .join('')
}

// A rows x cols cell box for a profile picture or team thumbnail, registered
// as a kitty slot so the painter draws the picture over it. Shows `label`
// (initials) until, or unless, the picture loads; with a null cacheKey the
// label is all there is.
export function PictureSlot(props: {
  slots: InlineImageSlots
  cacheKey: string | null
  rows: number
  cols: number
  label: string
  theme: Theme
}) {
  const { slots, cacheKey, rows } = props
  return (
    <Box
      width={props.cols}
      height={rows}
      flexShrink={0}
      ref={(node) => {
        if (!node || !cacheKey) return
        slots.set(node, { cacheKey, rows, inset: 0 })
        return () => {
          slots.delete(node)
        }
      }}
    >
      <Text color={props.theme.mutedText} wrap="truncate-end">
        {props.label.slice(0, props.cols)}
      </Text>
    </Box>
  )
}
