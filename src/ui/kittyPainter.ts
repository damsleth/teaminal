// One painter for every kitty image on screen.
//
// Kitty placements live outside Ink's frame, and clearing them
// (clearKittyImages) removes all of ours at once. So each pane that shows
// images registers its slots here as an owner, and one paint pass clears
// and re-places every owner's images after Ink flushes a frame. Two panes
// painting independently would erase each other's pictures.

import type { DOMElement } from 'ink'
import { clearKittyImages } from './kittyGraphics'
import { paintInlineImages, type InlineImageSlots } from './inlineImageLayout'

export type KittyOwner = {
  // The element whose rect clips this owner's images.
  viewport: () => DOMElement | null
  slots: InlineImageSlots
  // Escape for one slot; '' paints nothing.
  escape: (cacheKey: string, rows: number, fallbackKey?: string) => string
}

export type KittyPaintContext = {
  stdout: NodeJS.WriteStream
  // Ink's useApp().waitUntilRenderFlush: resolves once the text frame is out.
  flush: () => Promise<void>
  // A modal is open: images would draw on top of it, so paint none.
  suppressed: boolean
}

const owners = new Map<string, KittyOwner>()
let ctx: KittyPaintContext | null = null
let pending = false
let again = false

export function setKittyOwner(id: string, owner: KittyOwner | null): void {
  if (owner) owners.set(id, owner)
  else owners.delete(id)
}

// Repaint all owners after the next frame flush. Calls while one is pending
// fold into a single follow-up pass.
export function requestKittyPaint(next?: KittyPaintContext): void {
  if (next) ctx = next
  if (!ctx) return
  // No clear here: paintNow clears and re-places in one pass after the
  // flush, so a re-render that moved nothing doesn't blink every picture.
  // ponytail: a picture whose row moved sits one frame at the old spot.
  if (pending) {
    again = true
    return
  }
  pending = true
  void ctx.flush().then(() => {
    pending = false
    if (ctx) paintNow(ctx)
    if (again) {
      again = false
      requestKittyPaint()
    }
  })
}

function paintNow(c: KittyPaintContext): void {
  clearKittyImages(c.stdout)
  if (c.suppressed) return
  for (const owner of owners.values()) {
    const viewport = owner.viewport()
    if (viewport) paintInlineImages(c.stdout, viewport, owner.slots, owner.escape)
  }
}

export function __resetKittyPainterForTests(): void {
  owners.clear()
  ctx = null
  pending = false
  again = false
}
