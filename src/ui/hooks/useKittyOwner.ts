// A pane's membership in the shared kitty painter (kittyPainter.ts).
//
// Every render re-registers the owner (its slots and escapes follow the
// latest props) and asks for one paint after Ink flushes the frame. A null
// owner leaves the painter without asking for a paint, so a pane with no
// pictures doesn't clear and re-place the other panes' images on each of
// its re-renders. Unmounting removes the owner and repaints the rest.

import { useApp, useStdout } from 'ink'
import { useEffect } from 'react'
import { requestKittyPaint, setKittyOwner, type KittyOwner } from '../kittyPainter'

export function useKittyOwner(id: string, owner: KittyOwner | null, suppressed: boolean): void {
  const { stdout } = useStdout()
  const { waitUntilRenderFlush } = useApp()
  useEffect(() => {
    if (!stdout || !owner) {
      setKittyOwner(id, null)
      return
    }
    setKittyOwner(id, owner)
    requestKittyPaint({ stdout, flush: waitUntilRenderFlush, suppressed })
  })
  useEffect(
    () => () => {
      setKittyOwner(id, null)
      requestKittyPaint()
    },
    [id],
  )
}
