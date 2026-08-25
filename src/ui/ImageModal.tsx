// Full-size view for a focused inline image.
//
// Opened with Space on a focused image in the message pane, and the primary
// way to see an image when inline rendering is off or the terminal has no
// Kitty graphics support.
//
// `o` shows the picture at full resolution in the platform image viewer: the
// cached blob is written to a private temp file (see openImageFile.ts) and
// handed to the OS. That beats a second out-of-band Kitty placement inside
// this centred overlay — the offset math there is fragile, and a 3600x2014
// screenshot is unreadable at a dozen terminal rows anyway. An http(s) source
// still opens in the browser instead, so the user gets the original URL.
//
// ponytail: no in-terminal picture here. If a Kitty lightbox is wanted, give
// the modal deterministic geometry first (replace the pane like
// AuthExpiredModal rather than centring inside it), then reuse
// writeKittyImageAtOffset with the pane's bottom chrome.
//
// Keys: o = open the image, Space / Esc = close.

import { Box, Text, useApp, useInput } from 'ink'
import { useEffect, useState } from 'react'
import { getActiveProfile } from '../graph/client'
import { ensureImageFetched, getImageData } from '../state/imageCache'
import { detectImageFormat } from './kittyGraphics'
import { materializeImage, openImageFile } from './openImageFile'
import { openExternal } from './openExternal'
import { useAppState, useAppStore, useTheme } from './StoreContext'

function readPngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || detectImageFormat(buf) !== 'png') return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (width <= 0 || height <= 0) return null
  return { width, height }
}

// Browser-openable URL for an image ref: the preserved original URL (e.g. a
// SharePoint contentUrl whose sourcePath was rewritten to a Graph /shares
// path), else an external sourcePath. Graph-relative paths aren't openable.
function openableUrl(ref: {
  sourcePath: string
  isExternal: boolean
  openUrl?: string
}): string | null {
  if (ref.openUrl) return ref.openUrl
  if (ref.isExternal && /^https?:\/\//i.test(ref.sourcePath)) return ref.sourcePath
  return null
}

export function ImageModal() {
  const { exit } = useApp()
  const store = useAppStore()
  const modal = useAppState((s) => s.modal)
  const theme = useTheme()
  const isOpen = modal?.kind === 'image'
  const ref = isOpen ? modal.ref : null

  // Fetch-on-demand counter. With inline images off the pane never prefetches,
  // so this modal is what pulls the blob — and it has to re-render when it
  // lands. A store patch can't do that job here: every selector would see an
  // unchanged value and nothing would re-render.
  const [, setRevision] = useState(0)

  // Make sure the blob is in memory so we can report format/dimensions and
  // hand it to the viewer. Cheap when already cached (auto mode prefetches).
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
        onChange: () => setRevision((r) => r + 1),
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
      if (input.toLowerCase() === 'o' && ref) {
        // Prefer the original URL when there is one — the user gets the real
        // source. Otherwise show the cached blob in the platform viewer.
        const url = openableUrl(ref)
        if (url) {
          openExternal(url)
          store.set({ modal: null, inputZone: 'list' })
          return
        }
        const data = getImageData(ref.cacheKey)
        if (!data) return
        const path = materializeImage(ref.cacheKey, data)
        if (path && openImageFile(path)) {
          store.set({ modal: null, inputZone: 'list' })
        }
      }
    },
    { isActive: isOpen },
  )

  if (!isOpen || !ref) return null

  const data = getImageData(ref.cacheKey)
  const format = data ? detectImageFormat(data) : null
  const dims = data ? readPngDimensions(data) : null
  // Openable either as its original URL or as the cached blob, once fetched.
  const canOpen = openableUrl(ref) !== null || data !== null

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
      </Box>
      <Box marginTop={1}>
        <Text color={theme.mutedText}>
          {canOpen
            ? `o open image${openableUrl(ref) ? ' in browser' : ''} · `
            : data
              ? ''
              : 'loading… · '}
          space/esc close
        </Text>
      </Box>
    </Box>
  )
}
