// Always-on diagnostics tails.
//
// Renders up to three 1/3-width strips above the composer. Each strip
// is a small read-only feed of the corresponding modal panel:
//   - tailEvents:      last N event-log records (src/log.ts ring)
//   - tailNetwork:     last N Graph requests
//   - tailDiagnostics: token / capability summary
//
// Toggled via Menu → Settings → "Tail event log" / "Tail network" /
// "Tail diagnostics". Off by default; the modal panels remain the
// canonical surface, the tails are for users who want a live feed.

import { Box, Text } from 'ink'
import { useEffect, useState } from 'react'
import {
  getRecentEvents,
  getRecentRequests,
  subscribeEvents,
  subscribeRequests,
  type EventRecord,
  type RequestRecord,
} from '../log'
import { useAppState, useTheme } from './StoreContext'
import type { Theme } from './theme'

const TAIL_ROWS = 6

function formatTs(ts: number): string {
  const d = new Date(ts)
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  const ss = d.getSeconds().toString().padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function colorForLevel(theme: Theme, level: EventRecord['level']): string {
  if (level === 'error') return 'red'
  if (level === 'warn') return 'yellow'
  if (level === 'debug') return theme.mutedText
  return theme.text
}

function colorForStatus(theme: Theme, status: number | null): string {
  if (status === null) return theme.errorText
  if (status >= 500) return theme.errorText
  if (status >= 400) return theme.warnText
  return theme.text
}

function EventsTail({ theme }: { theme: Theme }) {
  const [records, setRecords] = useState<EventRecord[]>(() => getRecentEvents())
  useEffect(() => {
    setRecords(getRecentEvents())
    return subscribeEvents((rec) => {
      setRecords((prev) => {
        const next = prev.length >= 200 ? prev.slice(prev.length - 199) : prev.slice()
        next.push(rec)
        return next
      })
    })
  }, [])
  const tail = records.slice(-TAIL_ROWS)
  return (
    <Box flexDirection="column" paddingX={theme.layout.panePaddingX}>
      <Text bold={theme.emphasis.sectionHeadingBold} color={theme.mutedText}>
        events ({records.length})
      </Text>
      {tail.length === 0 ? (
        <Text color={theme.mutedText}>(none)</Text>
      ) : (
        tail.map((r, i) => (
          <Text key={`${r.ts}-${i}`} color={colorForLevel(theme, r.level)} wrap="truncate-end">
            {formatTs(r.ts)} {r.source.padEnd(8)} {r.message}
          </Text>
        ))
      )}
    </Box>
  )
}

function NetworkTail({ theme }: { theme: Theme }) {
  const [records, setRecords] = useState<RequestRecord[]>(() => getRecentRequests())
  useEffect(() => {
    setRecords(getRecentRequests())
    return subscribeRequests((rec) => {
      setRecords((prev) => {
        const next = prev.length >= 200 ? prev.slice(prev.length - 199) : prev.slice()
        next.push(rec)
        return next
      })
    })
  }, [])
  const tail = records.slice(-TAIL_ROWS)
  return (
    <Box flexDirection="column" paddingX={theme.layout.panePaddingX}>
      <Text bold={theme.emphasis.sectionHeadingBold} color={theme.mutedText}>
        network ({records.length})
      </Text>
      {tail.length === 0 ? (
        <Text color={theme.mutedText}>(none)</Text>
      ) : (
        tail.map((r, i) => {
          const status = r.status === null ? 'ERR' : String(r.status)
          return (
            <Text key={`${r.ts}-${i}`} color={colorForStatus(theme, r.status)} wrap="truncate-end">
              {formatTs(r.ts)} {r.method.padEnd(5)} {status.padStart(3)} {r.durationMs}ms {r.path}
            </Text>
          )
        })
      )}
    </Box>
  )
}

function DiagnosticsTail({ theme }: { theme: Theme }) {
  const me = useAppState((s) => s.me)
  const conn = useAppState((s) => s.conn)
  const realtimeState = useAppState((s) => s.realtimeState)
  const myPresence = useAppState((s) => s.myPresence)
  const capabilities = useAppState((s) => s.capabilities)
  const lastListPollAt = useAppState((s) => s.lastListPollAt)
  const chats = useAppState((s) => s.chats)
  return (
    <Box flexDirection="column" paddingX={theme.layout.panePaddingX}>
      <Text bold={theme.emphasis.sectionHeadingBold} color={theme.mutedText}>
        diagnostics
      </Text>
      <Text wrap="truncate-end">
        <Text color={theme.mutedText}>user </Text>
        <Text>{me?.displayName ?? '?'}</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text color={theme.mutedText}>conn </Text>
        <Text>{conn}</Text>
        <Text color={theme.mutedText}> · push </Text>
        <Text>{realtimeState}</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text color={theme.mutedText}>presence </Text>
        <Text>{(myPresence?.availability ?? '?').toLowerCase()}</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text color={theme.mutedText}>chats </Text>
        <Text>{chats.length}</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text color={theme.mutedText}>caps </Text>
        <Text>
          {[
            capabilities?.me.ok ? 'me' : null,
            capabilities?.chats.ok ? 'chats' : null,
            capabilities?.joinedTeams.ok ? 'teams' : null,
            capabilities?.presence.ok ? 'presence' : null,
          ]
            .filter(Boolean)
            .join(' · ') || '(probing)'}
        </Text>
      </Text>
      <Text wrap="truncate-end" color={theme.mutedText}>
        upd {lastListPollAt ? formatTs(lastListPollAt.getTime()) : '?'}
      </Text>
    </Box>
  )
}

export function TailPanels() {
  const tailEvents = useAppState((s) => s.settings.tailEvents)
  const tailNetwork = useAppState((s) => s.settings.tailNetwork)
  const tailDiagnostics = useAppState((s) => s.settings.tailDiagnostics)
  const theme = useTheme()

  const enabled: Array<'events' | 'network' | 'diagnostics'> = []
  if (tailEvents) enabled.push('events')
  if (tailNetwork) enabled.push('network')
  if (tailDiagnostics) enabled.push('diagnostics')
  if (enabled.length === 0) return null

  return (
    <Box
      flexDirection="row"
      borderStyle={theme.borders.panel}
      borderColor={theme.border}
      flexShrink={0}
    >
      {enabled.map((kind, i) => (
        <Box
          key={kind}
          flexBasis={0}
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          flexDirection="column"
          marginLeft={i === 0 ? 0 : theme.layout.tailGap}
        >
          {kind === 'events' ? (
            <EventsTail theme={theme} />
          ) : kind === 'network' ? (
            <NetworkTail theme={theme} />
          ) : (
            <DiagnosticsTail theme={theme} />
          )}
        </Box>
      ))}
    </Box>
  )
}
