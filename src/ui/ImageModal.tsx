// Full-size view for a focused inline image.
//
// Opened with Space on a focused image in the message pane. Inline images
// already render in the pane via the Kitty graphics layer; doing a second,
// larger out-of-band Kitty placement inside this centred sub-region overlay
// is fragile (a wrong row/col offset paints the picture in the wrong place),
// so the modal instead shows the image's details and offers to open the
// original at full resolution in the system browser / image viewer when the
// source is an openable URL (external GIFs, http(s)-hosted images).
//
// Keys: o = open original externally (when available), Space / Esc = close.

import { Box, Text, useApp, useInput } from 'ink'
import { useEffect } from 'react'
import { getActiveProfile } from '../graph/client'
import { ensureImageFetched, getImageData } from '../state/imageCache'
import { detectImageFormat } from './kittyGraphics'
import { openExternal } from './openExternal'
import { useAppState, useAppStore, useTheme } from './StoreContext'

function readPngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || detectImageFormat(buf) !== 'png') return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (width <= 0 || height <= 0) return null
  return { width, height }
}

function isOpenableSource(sourcePath: string, isExternal: boolean): boolean {
  return isExternal && /^https?:\/\//i.test(sourcePath)
}

export function ImageModal() {
  const { exit } = useApp()
  const store = useAppStore()
  const modal = useAppState((s) => s.modal)
  const theme = useTheme()
  const isOpen = modal?.kind === 'image'
  const ref = isOpen ? modal.ref : null

  // Make sure the blob is on disk / in memory so we can report format and
  // dimensions. Cheap when already cached (the pane usually fetched it).
  useEffect(() => {
    if (!ref) return
    ensureImageFetched(
      ref.sourcePath,
      ref.cacheKey,
      { contentType: ref.contentType, name: ref.name },
      {
        profile: getActiveProfile(),
        isExternal: ref.isExternal,
        ...(ref.objectId ? { objectId: ref.objectId } : {}),
        ...(ref.region ? { region: ref.region } : {}),
        onChange: () => store.set((s) => ({ ...s })),
      },
    )
  }, [ref?.cacheKey])

  useInput(
    (input, key) => {
      if (!isOpen) return
      if (key.ctrl && input.toLowerCase() === 'c') {
        exit()
        return
      }
      if (key.escape || input === ' ') {
        store.set({ modal: null, inputZone: 'list' })
        return
      }
      if (input.toLowerCase() === 'o' && ref && isOpenableSource(ref.sourcePath, ref.isExternal)) {
        openExternal(ref.sourcePath)
        store.set({ modal: null, inputZone: 'list' })
      }
    },
    { isActive: isOpen },
  )

  if (!isOpen || !ref) return null

  const data = getImageData(ref.cacheKey)
  const format = data ? detectImageFormat(data) : null
  const dims = data ? readPngDimensions(data) : null
  const canOpen = isOpenableSource(ref.sourcePath, ref.isExternal)

  return (
    <Box
      flexDirection="column"
      borderStyle={theme.borders.modal}
      borderColor={theme.borderActive}
      backgroundColor={theme.background}
      paddingX={theme.layout.modalPaddingX}
      paddingY={theme.layout.modalPaddingY}
    >
      <Text bold={theme.emphasis.modalTitleBold}>{ref.name || 'image'}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.mutedText}>
          {format ? `format: ${format}` : data ? 'format: unknown' : 'loading…'}
          {dims ? `  ·  ${dims.width}×${dims.height}` : ''}
        </Text>
        <Text color={theme.mutedText}>
          {ref.isExternal ? 'source: external' : 'source: Teams hosted content'}
        </Text>
        {format === 'png' && (
          <Text color={theme.mutedText}>shown inline in the message pane (Kitty terminals)</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.mutedText}>
          {canOpen ? 'o open original in browser · ' : ''}
          space/esc close
        </Text>
      </Box>
    </Box>
  )
}
