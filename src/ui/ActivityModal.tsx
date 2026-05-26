// Activity feed overlay (Teams web's bell-icon panel).
//
// Pulls from the CSA /api/csa/.../updates response stashed in
// state.activityFeed. j/k navigates, Enter jumps the main view to the
// source chat + message. Esc closes.
//
// The list is dedup'd at the reducer (mergeActivityItems) so the same
// activity arriving twice — once via initial hydrate, once via trouter
// push reconcile — renders as one row.

import { Box, Text, useApp, useInput } from 'ink'
import { useEffect } from 'react'
import type { ActivityItem } from '../graph/teamsActivity'
import {
  countUnreadMentions,
  markActivityRead,
  refreshActivityFeed,
} from '../state/activityFeed'
import { useAppState, useAppStore, useTheme } from './StoreContext'

export function openActivity(store: ReturnType<typeof useAppStore>): void {
  store.set({ modal: { kind: 'activity', cursor: 0 }, inputZone: 'menu' })
}

function kindGlyph(kind: ActivityItem['kind']): string {
  switch (kind) {
    case 'mention':
      return '@'
    case 'reply':
      return '↳'
    case 'reaction':
      return '♡'
    case 'follow-post':
      return '★'
    case 'missed-call':
      return '☎'
    case 'team-added':
      return '+'
    default:
      return '·'
  }
}

function relativeTime(iso: string, now: number): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const dMs = Math.max(0, now - t)
  const minutes = Math.floor(dMs / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(t).toISOString().slice(0, 10)
}

const VISIBLE_ROWS = 14

export function ActivityModal() {
  const { exit } = useApp()
  const store = useAppStore()
  const modal = useAppState((s) => s.modal)
  const items = useAppState((s) => s.activityFeed)
  const theme = useTheme()
  const isOpen = modal?.kind === 'activity'
  const cursor = isOpen ? modal.cursor : 0

  // On open, opportunistically refresh from the server so the user sees
  // any items that arrived between the last reconcile and now.
  useEffect(() => {
    if (!isOpen) return
    void refreshActivityFeed(store)
  }, [isOpen, store])

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
      if (ch === 'j' || key.downArrow) {
        const next = Math.min(items.length - 1, cursor + 1)
        store.set({ modal: { kind: 'activity', cursor: next } })
        return
      }
      if (ch === 'k' || key.upArrow) {
        const next = Math.max(0, cursor - 1)
        store.set({ modal: { kind: 'activity', cursor: next } })
        return
      }
      if (ch === 'a') {
        // Mark all as read locally. CSA exposes a server-side "mark
        // read" endpoint, but we don't roundtrip it — the local count
        // resets, which is what matters for the unread badge.
        store.set((s) => {
          const next = markActivityRead(s.activityFeed, 'all')
          return {
            activityFeed: next,
            unreadMentionCount: countUnreadMentions(next),
          }
        })
        return
      }
      if (key.return && items[cursor]) {
        const item = items[cursor]
        if (item.chatId) {
          // Open the source chat. Channel ids start with 19:...@thread.tacv2;
          // chat ids look like 19:meeting_... or 19:..._@unq.gbl.spaces.
          // Without a channel/team mapping at hand, dispatch to a chat focus
          // — the existing list/realtime reconcile will surface unknown
          // chats. (Channel jump is left as a follow-up.)
          if (item.chatId.includes('@thread.tacv2')) {
            // Channel — we don't have teamId here, fall through and just close.
            // A future iteration can index channelsByTeam to resolve.
          } else {
            store.set({
              focus: { kind: 'chat', chatId: item.chatId },
              modal: null,
              inputZone: 'list',
              activityFeed: markActivityRead(items, [item.id]),
              unreadMentionCount: countUnreadMentions(markActivityRead(items, [item.id])),
            })
            return
          }
        }
        // No chatId or unsupported jump target: at least mark this row as read.
        store.set((s) => {
          const next = markActivityRead(s.activityFeed, [item.id])
          return {
            activityFeed: next,
            unreadMentionCount: countUnreadMentions(next),
          }
        })
      }
    },
    { isActive: isOpen },
  )

  if (!isOpen) return null

  // Sliding window over the items list.
  const top = Math.max(0, Math.min(items.length - VISIBLE_ROWS, cursor - Math.floor(VISIBLE_ROWS / 2)))
  const visible = items.slice(top, top + VISIBLE_ROWS)
  const now = Date.now()
  const totalUnread = items.filter((it) => !it.isRead).length

  return (
    <Box alignItems="center" justifyContent="center" flexGrow={1}>
      <Box
        flexDirection="column"
        borderStyle={theme.borders.modal}
        borderColor={theme.borderActive}
        backgroundColor={theme.background}
        paddingX={theme.layout.modalPaddingX}
        paddingY={theme.layout.modalPaddingY}
        width={86}
      >
        <Text bold={theme.emphasis.modalTitleBold}>
          Activity{totalUnread > 0 ? ` (${totalUnread} unread)` : ''}
        </Text>
        <Box height={1} />
        {items.length === 0 ? (
          <Text color="gray">(no activity)</Text>
        ) : (
          visible.map((it, i) => {
            const absIdx = top + i
            const focused = absIdx === cursor
            const arrow = focused ? '>' : ' '
            const sender = (it.senderDisplayName ?? '?').slice(0, 18).padEnd(18)
            const preview = (it.preview ?? '').slice(0, 40).padEnd(40)
            const when = relativeTime(it.createdAt, now).padStart(4)
            const unreadDot = it.isRead ? ' ' : '●'
            return (
              <Text key={it.id}>
                <Text color={theme.selected}>{arrow} </Text>
                <Text color={theme.warnText}>{unreadDot} </Text>
                <Text>{kindGlyph(it.kind)} </Text>
                <Text bold={focused}>{sender}</Text>
                <Text> </Text>
                <Text color="gray">{preview}</Text>
                <Text color="gray"> {when}</Text>
              </Text>
            )
          })
        )}
        <Box height={1} />
        <Text color="gray">j/k: move · enter: open · a: mark all read · esc: close</Text>
      </Box>
    </Box>
  )
}
