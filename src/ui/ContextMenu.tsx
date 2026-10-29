// Context menu ('.' or Ctrl+.) for the selected chat-list row or the focused
// message: a small menu beside the item with the actions it supports
// (./contextMenu). j/k / ↑↓ move, Enter / Space / → run, an entry's key
// runs it directly, Esc / ← / h close.

import { Box, useStdout, type DOMElement } from 'ink'
import { Text } from './Text'
import { useEffect, useRef, useState } from 'react'
import type { AppState, Store } from '../state/store'
import { anchorRect } from './contextAnchor'
import { contextMenuEntries, type ContextMenuTarget } from './contextMenuEntries'
import { elementRect } from './inlineImageLayout'
import { openThread } from './keybinds/chatKeys'
import { useAppState, useAppStore, useTheme } from './StoreContext'
import { inkBorder, modalBg } from './theme'
import { useInput } from './useInput'

export function openContextMenu(store: Store<AppState>, target: ContextMenuTarget): void {
  store.set({ modal: { kind: 'context-menu', target, cursor: 0 }, inputZone: 'menu' })
}

export function ContextMenu() {
  const store = useAppStore()
  const theme = useTheme()
  const { stdout } = useStdout()
  const state = useAppState((s) => (s.modal?.kind === 'context-menu' ? s : null))
  const originRef = useRef<DOMElement>(null)
  const [origin, setOrigin] = useState<{
    top: number
    left: number
    width: number
    height: number
  } | null>(null)
  // The overlay's own position, to turn the anchor's terminal coordinates
  // into offsets inside it (known after the first layout).
  useEffect(() => {
    if (!originRef.current) return
    const r = elementRect(originRef.current)
    if (!origin || r.top !== origin.top || r.left !== origin.left || r.width !== origin.width)
      setOrigin({ top: r.top, left: r.left, width: r.width, height: r.height })
  })

  const modal = state?.modal?.kind === 'context-menu' ? state.modal : null
  const entries =
    state && modal
      ? contextMenuEntries(modal.target, state, {
          store,
          openThread: (focus, messageId) => {
            const msg = state.messagesByConvo[`channel:${focus.teamId}:${focus.channelId}`]?.find(
              (m) => m.id === messageId,
            )
            openThread(store, focus, messageId, msg)
          },
        })
      : []
  const cursor = modal ? Math.min(modal.cursor, Math.max(0, entries.length - 1)) : 0

  const close = () => store.set({ modal: null, inputZone: 'list' })
  const run = (index: number) => {
    const entry = entries[index]
    if (!entry) return
    // Close first: an entry may open its own modal or the composer.
    close()
    entry.run()
  }

  useInput(
    (input, key) => {
      if (!modal) return
      const ch = input.toLowerCase()
      if (key.escape || key.leftArrow || ch === 'h') return close()
      if (key.upArrow || ch === 'k')
        return store.set({ modal: { ...modal, cursor: Math.max(0, cursor - 1) } })
      if (key.downArrow || ch === 'j')
        return store.set({ modal: { ...modal, cursor: Math.min(entries.length - 1, cursor + 1) } })
      if (key.return || input === ' ' || key.rightArrow || ch === 'l') return run(cursor)
      // An entry's own key runs it (single letters and Ctrl+letter).
      const byKey = entries.findIndex((e) =>
        e.key.startsWith('Ctrl+')
          ? key.ctrl && ch === e.key.slice(5).toLowerCase()
          : !key.ctrl && input === e.key,
      )
      if (byKey !== -1) run(byKey)
    },
    { isActive: modal !== null },
  )

  if (!modal) return null

  const bg = modalBg(theme)
  const keyW = Math.max(...entries.map((e) => e.key.length), 1)
  const labelW = Math.max(...entries.map((e) => e.label.length), 12)
  const innerW = 2 + labelW + 2 + keyW
  const boxW = innerW + 2 + 2 * 1
  const boxH = Math.max(1, entries.length) + 2

  // Beside the chat row / under the message, kept inside the overlay.
  const anchor = anchorRect(modal.target.kind === 'chat' ? 'list' : 'message')
  let pos: { top: number; left: number } | null = null
  if (origin && anchor) {
    const wantTop =
      modal.target.kind === 'chat'
        ? anchor.top - origin.top
        : anchor.top + anchor.height - origin.top
    const wantLeft =
      modal.target.kind === 'chat'
        ? anchor.left + anchor.width - origin.left
        : anchor.left + 2 - origin.left
    const maxTop = Math.max(0, origin.height - boxH)
    const maxLeft = Math.max(0, (stdout?.columns ?? origin.width) - origin.left - boxW)
    pos = {
      top: Math.max(0, Math.min(wantTop, maxTop)),
      left: Math.max(0, Math.min(wantLeft, maxLeft)),
    }
  }

  const menu = (
    <Box
      flexDirection="column"
      width={boxW}
      borderStyle={inkBorder(theme.borders.modal)}
      borderColor={theme.borderActive}
      backgroundColor={bg}
      paddingX={1}
    >
      {entries.length === 0 ? (
        <Text color={theme.mutedText} backgroundColor={bg}>
          {'nothing to do here'.padEnd(innerW)}
        </Text>
      ) : (
        entries.map((e, i) => {
          const sel = i === cursor
          return (
            <Text key={e.id} backgroundColor={sel ? (theme.selectedRowBackground ?? bg) : bg}>
              <Text
                color={sel ? theme.selected : theme.text}
                bold={sel && theme.emphasis.selectedBold}
              >
                {`${sel ? '>' : ' '} ${e.label.padEnd(labelW)}  `}
              </Text>
              <Text color={theme.mutedText}>{e.key.padStart(keyW)}</Text>
            </Text>
          )
        })
      )}
    </Box>
  )

  return (
    <Box ref={originRef} position="absolute" top={0} left={0} width="100%" height="100%">
      {pos ? (
        <Box position="absolute" top={pos.top} left={pos.left}>
          {menu}
        </Box>
      ) : (
        <Box flexGrow={1} alignItems="center" justifyContent="center">
          {menu}
        </Box>
      )}
    </Box>
  )
}
