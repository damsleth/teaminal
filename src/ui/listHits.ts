// Which chat-list row a mouse click landed on. ChatList registers each
// rendered row's box under its selectable key, and the list box itself, by
// ref callback (as contextAnchor does); positions are read at click time
// from the last laid-out frame.
//
// Yoga gives border boxes, not what is visible: a row's margins (account
// gap, row gap) are outside it, rows below the viewport slice are not
// rendered at all, and the list box, which is as tall as its content, is
// not clipped by the pane around it. So a row only counts where it lies
// inside the list box and the pane's interior (inside its border), the way
// Ink clips overflow. The terminal bounds need no check: a report can only
// come from a cell on screen.

import type { DOMElement } from 'ink'
import { elementRect } from './inlineImageLayout'

const rows = new Map<DOMElement, string>()
let clip: DOMElement | null = null

export function listRowRef(key: string) {
  return (node: DOMElement | null) => {
    if (!node) return
    rows.set(node, key)
    return () => {
      // React may hand the same box to the next row before this runs.
      if (rows.get(node) === key) rows.delete(node)
    }
  }
}

export function listClipRef(node: DOMElement | null) {
  if (!node) return
  clip = node
  return () => {
    if (clip === node) clip = null
  }
}

type Bounds = { top: number; left: number; bottom: number; right: number }

// The cells inside a box's border (Ink draws a border 1 cell wide on every
// edge it doesn't turn off).
function interior(node: DOMElement): Bounds {
  const r = elementRect(node)
  const s = node.style
  const edge = (on: boolean | undefined) => (s.borderStyle && on !== false ? 1 : 0)
  return {
    top: r.top + edge(s.borderTop),
    left: r.left + edge(s.borderLeft),
    bottom: r.top + r.height - edge(s.borderBottom),
    right: r.left + r.width - edge(s.borderRight),
  }
}

const contains = (b: Bounds, x: number, y: number) =>
  x >= b.left && x < b.right && y >= b.top && y < b.bottom

// The cell (x, y) lies inside the node's border box.
export function hitsElement(node: DOMElement | null, x: number, y: number): boolean {
  if (!node) return false
  const r = elementRect(node)
  return contains(
    { top: r.top, left: r.left, bottom: r.top + r.height, right: r.left + r.width },
    x,
    y,
  )
}

function under(node: DOMElement, ancestor: DOMElement): boolean {
  for (let n: DOMElement | undefined = node.parentNode; n; n = n.parentNode) {
    if (n === ancestor) return true
  }
  return false
}

// Conversation tabs (TabBar) register the same way, under their index.
const tabs = new Map<DOMElement, number>()

export function tabHitRef(index: number) {
  return (node: DOMElement | null) => {
    if (!node) return
    tabs.set(node, index)
    return () => {
      if (tabs.get(node) === index) tabs.delete(node)
    }
  }
}

// The index of the tab drawn at the 0-based cell (x, y), or null. The bar is
// one row that never scrolls, so a tab's box is what is visible.
export function tabIndexAt(x: number, y: number): number | null {
  for (const [node, index] of tabs) {
    if (hitsElement(node, x, y)) return index
  }
  return null
}

// The selectable key of the row drawn at the 0-based cell (x, y), or null.
export function listRowKeyAt(x: number, y: number): string | null {
  if (!clip) return null
  const bounds = [interior(clip), ...(clip.parentNode ? [interior(clip.parentNode)] : [])]
  if (!bounds.every((b) => contains(b, x, y))) return null
  for (const [node, key] of rows) {
    // A row left over from an unmounted list is not under the live one.
    if (!under(node, clip)) continue
    if (hitsElement(node, x, y)) return key
  }
  return null
}
