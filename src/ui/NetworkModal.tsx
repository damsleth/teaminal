// Network overlay.
//
// Triggered from the menu (Help -> Network). Renders the in-memory
// per-request ring buffer from src/log.ts (recordRequest, populated by
// src/graph/client.ts) as a scrolling list. Path-only - no full URLs,
// no headers, no bodies.
//
// Esc closes. j/k or ↓/↑ scroll. g jumps to the tail.

import { Box, Text, useApp, useInput } from 'ink'
import { useEffect, useState } from 'react'
import { getRecentRequests, subscribeRequests, type RequestRecord } from '../log'
import { useAppState, useAppStore, useTheme } from './StoreContext'

const VISIBLE_ROWS = 18

export function openNetwork(store: ReturnType<typeof useAppStore>): void {
  store.set({ modal: { kind: 'network' }, inputZone: 'menu' })
}

function formatTs(ts: number): string {
  const d = new Date(ts)
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  const ss = d.getSeconds().toString().padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function colorForStatus(theme: ReturnType<typeof useTheme>, status: number | null): string {
  if (status === null) return theme.errorText
  if (status >= 500) return theme.errorText
  if (status === 429) return theme.warnText
  if (status >= 400) return theme.warnText
  return theme.text
}

export function NetworkModal() {
  const { exit } = useApp()
  const store = useAppStore()
  const theme = useTheme()
  const modal = useAppState((s) => s.modal)
  const isOpen = modal?.kind === 'network'

  const [records, setRecords] = useState<RequestRecord[]>(() => getRecentRequests())
  const [cursor, setCursor] = useState<number | null>(null)

  useEffect(() => {
    if (!isOpen) return
    setRecords(getRecentRequests())
    return subscribeRequests((rec) => {
      setRecords((prev) => {
        const next = prev.length >= 200 ? prev.slice(prev.length - 199) : prev.slice()
        next.push(rec)
        return next
      })
    })
  }, [isOpen])

  useInput(
    (input, key) => {
      const ch = input.toLowerCase()
      if (key.escape) {
        store.set({ modal: null, inputZone: 'list' })
        return
      }
      if (key.ctrl && ch === 'c') {
        exit()
        return
      }
      if (key.downArrow || ch === 'j') {
        setCursor((c) => Math.min((c ?? records.length - 1) + 1, records.length - 1))
        return
      }
      if (key.upArrow || ch === 'k') {
        setCursor((c) => Math.max((c ?? records.length - 1) - 1, 0))
        return
      }
      if (ch === 'g') {
        setCursor(null)
        return
      }
    },
    { isActive: isOpen },
  )

  if (!isOpen) return null

  const totalCount = records.length
  const tail = cursor === null
  const focused = tail
    ? Math.max(totalCount - 1, 0)
    : Math.min(Math.max(cursor!, 0), Math.max(totalCount - 1, 0))
  const start = Math.max(focused - VISIBLE_ROWS + 1, 0)
  const slice = records.slice(start, start + VISIBLE_ROWS)

  return (
    <Box alignItems="center" justifyContent="center" flexGrow={1}>
      <Box
        flexDirection="column"
        borderStyle={theme.borders.modal}
        borderColor={theme.borderActive}
        backgroundColor={theme.background}
        paddingX={theme.layout.modalPaddingX}
        paddingY={theme.layout.modalPaddingY}
        width={100}
      >
        <Text bold={theme.emphasis.modalTitleBold}>Network ({totalCount})</Text>
        <Box height={1} />
        {slice.length === 0 ? (
          <Text color={theme.mutedText}>No requests yet.</Text>
        ) : (
          slice.map((r, i) => {
            const isFocused = !tail && i + start === focused
            const statusText = r.status === null ? 'ERR' : String(r.status)
            const retryFlag = r.retried429 ? ' r429' : r.retried401 ? ' r401' : ''
            const path = r.path.length > 50 ? `${r.path.slice(0, 50)}…` : r.path
            return (
              <Text
                key={`${r.ts}-${i}`}
                color={colorForStatus(theme, r.status)}
                inverse={isFocused}
              >
                {formatTs(r.ts)}
                {'  '}
                <Text color={theme.mutedText}>{r.method.padEnd(6)}</Text>
                {path.padEnd(52)} {statusText.padStart(3)}
                {'  '}
                <Text color={theme.mutedText}>{`${r.durationMs}ms${retryFlag}`}</Text>
              </Text>
            )
          })
        )}
        <Box height={1} />
        <Text color={theme.mutedText}>j/k scroll · g tail · esc closes</Text>
      </Box>
    </Box>
  )
}
