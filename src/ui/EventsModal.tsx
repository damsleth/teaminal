// Events overlay.
//
// Triggered from the menu (Diagnostics -> Events). Renders the in-memory
// ring buffer from src/log.ts as a scrolling list of recent events, with
// a type-ahead filter and color-by-level. Read-only - this is for
// debugging.
//
// Esc closes. j/k or ↓/↑ scroll. Typing builds a filter; Backspace edits.
// The list auto-tails (newest at the bottom) until the user moves the
// cursor; then it stays put until they hit g to jump to the bottom.

import { Box, Text, useApp, useInput } from 'ink'
import { useEffect, useState } from 'react'
import { getRecentEvents, subscribeEvents, type EventRecord } from '../log'
import { useAppState, useAppStore, useTheme } from './StoreContext'

const VISIBLE_ROWS = 18

export function openEvents(store: ReturnType<typeof useAppStore>): void {
  store.set({ modal: { kind: 'events' }, inputZone: 'menu' })
}

function formatTs(ts: number): string {
  const d = new Date(ts)
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  const ss = d.getSeconds().toString().padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function colorForLevel(theme: ReturnType<typeof useTheme>, level: EventRecord['level']): string {
  if (level === 'error') return 'red'
  if (level === 'warn') return 'yellow'
  if (level === 'debug') return theme.mutedText
  return theme.text
}

export function EventsModal() {
  const { exit } = useApp()
  const store = useAppStore()
  const theme = useTheme()
  const modal = useAppState((s) => s.modal)
  const isOpen = modal?.kind === 'events'

  const [records, setRecords] = useState<EventRecord[]>(() => getRecentEvents())
  const [filter, setFilter] = useState('')
  const [cursor, setCursor] = useState<number | null>(null)

  useEffect(() => {
    if (!isOpen) return
    setRecords(getRecentEvents())
    return subscribeEvents((rec) => {
      setRecords((prev) => {
        const next = prev.length >= 500 ? prev.slice(prev.length - 499) : prev.slice()
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
      if (key.backspace || key.delete) {
        setFilter((f) => f.slice(0, -1))
        return
      }
      if (input && !key.ctrl && !key.meta && input.length === 1) {
        // Reserve some characters that already mean things in this modal.
        if (ch === 'j' || ch === 'k' || ch === 'g') return
        setFilter((f) => f + input)
      }
    },
    { isActive: isOpen },
  )

  if (!isOpen) return null

  // Hide debug-level events by default - the active-loop chatter
  // drowns the things you actually want to see. Type "debug" in the
  // filter to surface them, or set TEAMINAL_DEBUG=1.
  const showDebug = filter.toLowerCase().includes('debug') || process.env.TEAMINAL_DEBUG === '1'
  const filtered = records
    .filter((r) => showDebug || r.level !== 'debug')
    .filter((r) => {
      if (!filter) return true
      const f = filter.toLowerCase()
      return r.source.includes(f) || r.level.includes(f) || r.message.toLowerCase().includes(f)
    })

  const totalCount = filtered.length
  const tail = cursor === null
  const focused = tail
    ? Math.max(totalCount - 1, 0)
    : Math.min(Math.max(cursor!, 0), Math.max(totalCount - 1, 0))
  const start = Math.max(focused - VISIBLE_ROWS + 1, 0)
  const slice = filtered.slice(start, start + VISIBLE_ROWS)

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
        <Text bold={theme.emphasis.modalTitleBold}>Events ({totalCount})</Text>
        <Box height={1} />
        {slice.length === 0 ? (
          <Text color={theme.mutedText}>No events.</Text>
        ) : (
          slice.map((r, i) => {
            const isFocused = !tail && i + start === focused
            return (
              <Text
                key={`${r.ts}-${i}`}
                color={colorForLevel(theme, r.level)}
                inverse={isFocused}
                wrap="wrap"
              >
                {formatTs(r.ts)}
                {'  '}
                <Text color={theme.mutedText}>{r.source.padEnd(8)}</Text>
                {r.message}
              </Text>
            )
          })
        )}
        <Box height={1} />
        <Text color={theme.mutedText}>
          filter: {filter || '(none)'} · j/k scroll · g tail · esc closes
        </Text>
      </Box>
    </Box>
  )
}
