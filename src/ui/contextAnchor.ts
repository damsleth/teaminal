// Where the context menu's target sits on screen: the selected chat-list
// row and the focused message register their box here (ref callbacks), and
// the menu opens beside it. Read at render, from the last laid-out frame.

import type { DOMElement } from 'ink'
import { elementRect } from './inlineImageLayout'

export type AnchorKind = 'list' | 'message'

const anchors: Partial<Record<AnchorKind, DOMElement>> = {}

function anchorRef(kind: AnchorKind) {
  return (node: DOMElement | null) => {
    if (!node) return
    anchors[kind] = node
    return () => {
      if (anchors[kind] === node) delete anchors[kind]
    }
  }
}

// Stable ref callbacks (one per kind) for the components to attach.
export const listAnchorRef = anchorRef('list')
export const messageAnchorRef = anchorRef('message')

export function anchorRect(kind: AnchorKind): ReturnType<typeof elementRect> | null {
  const node = anchors[kind]
  return node ? elementRect(node) : null
}
