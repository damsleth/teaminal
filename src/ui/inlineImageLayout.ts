import type { DOMElement } from 'ink'

export type InlineImageSlots = Map<DOMElement, { cacheKey: string; rows: number; inset: number }>

// Ink exposes Yoga coordinates relative to each parent. The app fills the
// terminal, so their sum is the zero-based terminal position.
export function elementRect(node: DOMElement) {
  let top = 0
  let left = 0
  for (let current: DOMElement | undefined = node; current; current = current.parentNode) {
    top += current.yogaNode?.getComputedTop() ?? 0
    left += current.yogaNode?.getComputedLeft() ?? 0
  }
  return {
    top,
    left,
    height: node.yogaNode?.getComputedHeight() ?? 0,
    width: node.yogaNode?.getComputedWidth() ?? 0,
  }
}

export function paintInlineImages(
  stdout: NodeJS.WriteStream,
  pane: DOMElement,
  slots: InlineImageSlots,
  imageEscape: (cacheKey: string, rows: number) => string,
): void {
  const viewport = elementRect(pane)
  let output = ''
  for (const [node, slot] of slots) {
    const rect = elementRect(node)
    // Kitty placements do not inherit Ink's overflow clipping. Omit a slot
    // unless its entire reserved height fits in the pane and terminal.
    if (
      rect.height < slot.rows ||
      rect.top < Math.max(0, viewport.top) ||
      rect.top + slot.rows > Math.min(stdout.rows, viewport.top + viewport.height) ||
      rect.left + slot.inset >= stdout.columns
    )
      continue
    const apc = imageEscape(slot.cacheKey, slot.rows)
    if (apc)
      output += `\x1b[${Math.round(rect.top) + 1};${Math.round(rect.left + slot.inset) + 1}H${apc}`
  }
  if (output) stdout.write(`\x1b7${output}\x1b8`)
}
