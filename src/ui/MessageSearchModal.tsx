// Tenant-wide message search overlay (server-side, Microsoft Search API).
//
// Distinct from the in-conversation search (S1, the `/` bar) — this reaches
// messages across every chat/channel, not just the loaded window. Typing
// debounces into searchAllMessages; j/k move between hits; Enter jumps to the
// hit's conversation (chat hits only — channel hits lack a team mapping here
// and render as non-jumpable rows); Esc closes.

import { Box, Text, useApp, useInput } from 'ink'
import { useEffect, useState } from 'react'
import { searchAllMessages } from '../state/chatActions'
import { clampCursor } from '../state/selectables'
import type { AppState, Store } from '../state/store'
import type { ChatMessageSearchHit } from '../types'
import { useAppState, useAppStore, useTheme } from './StoreContext'

const DEBOUNCE_MS = 350
const RESULT_LIMIT = 25
const VISIBLE_ROWS = 10

export function openMessageSearch(store: Store<AppState>): void {
  store.set({ modal: { kind: 'message-search-global' }, inputZone: 'menu' })
}

export function MessageSearchModal() {
  const { exit } = useApp()
  const store = useAppStore()
  const modal = useAppState((s) => s.modal)
  const theme = useTheme()
  const isOpen = modal?.kind === 'message-search-global'

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ChatMessageSearchHit[]>([])
  const [cursor, setCursor] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    const q = query.trim()
    if (q.length < 2) {
      setResults([])
      setCursor(0)
      setError(null)
      return
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => {
      setLoading(true)
      setError(null)
      searchAllMessages(q, { size: RESULT_LIMIT, signal: ctrl.signal })
        .then((hits) => {
          setResults(hits)
          setCursor(0)
        })
        .catch((err) => {
          if (ctrl.signal.aborted) return
          setError(err instanceof Error ? err.message : 'search failed')
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setLoading(false)
        })
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      ctrl.abort()
    }
  }, [query, isOpen])

  useInput(
    (input, key) => {
      if (!isOpen) return
      const ch = input.toLowerCase()
      if (key.escape) {
        store.set({ modal: null, inputZone: 'list' })
        return
      }
      if (key.ctrl && ch === 'c') {
        exit()
        return
      }
      if (key.downArrow || (key.ctrl && ch === 'n')) {
        setCursor((c) => clampCursor(c + 1, results.length))
        return
      }
      if (key.upArrow || (key.ctrl && ch === 'p')) {
        setCursor((c) => clampCursor(c - 1, results.length))
        return
      }
      if (key.return) {
        const hit = results[clampCursor(cursor, results.length)]
        if (hit?.chatId) {
          store.set({ focus: { kind: 'chat', chatId: hit.chatId }, modal: null, inputZone: 'list' })
        }
        return
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1))
        return
      }
      if (input && !key.ctrl && !key.meta) {
        setQuery((q) => q + input)
      }
    },
    { isActive: isOpen },
  )

  if (!isOpen) return null

  const safeCursor = clampCursor(cursor, results.length)
  const top = Math.max(
    0,
    Math.min(results.length - VISIBLE_ROWS, safeCursor - Math.floor(VISIBLE_ROWS / 2)),
  )
  const visible = results.slice(top, top + VISIBLE_ROWS)

  return (
    <Box alignItems="center" justifyContent="center" flexGrow={1}>
      <Box
        flexDirection="column"
        borderStyle={theme.borders.modal}
        borderColor={theme.borderActive}
        paddingX={theme.layout.modalPaddingX}
        paddingY={theme.layout.modalPaddingY}
        width={70}
      >
        <Text bold={theme.emphasis.modalTitleBold}>Search all messages</Text>
        <Box height={1} />
        <Text>
          <Text color="gray">/ </Text>
          {query}
          <Text color="cyan">█</Text>
        </Text>
        {loading && <Text color="gray">Searching…</Text>}
        {error && <Text color={theme.errorText}>{error.slice(0, 120)}</Text>}
        {!loading && !error && query.trim().length >= 2 && results.length === 0 && (
          <Text color="gray">No matches</Text>
        )}
        {visible.map((hit, i) => {
          const idx = top + i
          const selected = idx === safeCursor
          const time = hit.createdDateTime ? hit.createdDateTime.slice(0, 16).replace('T', ' ') : ''
          const sender = hit.senderDisplayName ?? '(unknown)'
          const jumpable = !!hit.chatId
          return (
            <Box key={`${hit.messageId}-${idx}`} flexDirection="column">
              <Text
                color={selected ? theme.selected : undefined}
                bold={selected && theme.emphasis.selectedBold}
                wrap="truncate-end"
              >
                {selected ? '> ' : '  '}
                {sender}
                <Text color="gray">{`  ${time}${jumpable ? '' : '  (channel)'}`}</Text>
              </Text>
              <Text color={theme.mutedText} wrap="truncate-end">
                {`    ${hit.snippet}`}
              </Text>
            </Box>
          )
        })}
        <Box height={1} />
        <Text color="gray">↑/↓ move · Enter opens chat · Esc closes</Text>
      </Box>
    </Box>
  )
}
