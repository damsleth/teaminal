// Notifications overlay (Teams web's bell-icon activity panel).
//
// Pulls from the CSA /api/csa/.../updates response stashed in
// state.activityFeed, plus the chat messages teaminal itself notified
// about (recordNotification, kind 'message'). j/k navigates, Enter jumps the main view to the
// source chat + message. Esc closes.
//
// Several accounts open (the unified sidebar): every open account's feed,
// grouped under an account header in sidebar order, accounts without items
// left out. Enter brings an item's account to the front first; mark-read
// writes to the owning account.
//
// The list is dedup'd at the reducer (mergeActivityItems) so the same
// activity arriving twice — once via initial hydrate, once via trouter
// push reconcile — renders as one row.

import { fitCells } from './textSizing'
import { Box, useApp } from 'ink'
import { Text } from './Text'
import { inkBorder, modalBg } from './theme'
import { useInput } from './useInput'
import { useEffect, useMemo } from 'react'
import { accountRef, type AccountRef } from '../account'
import type { ActivityItem } from '../graph/teamsActivity'
import { accountStore, accountStoreFor } from '../state/accountStore'
import { markAccountActivityRead, refreshActivityFeed } from '../state/activityFeed'
import { tenantSuffix } from './ChatList'
import { bringToFront } from './keybinds/itemActions'
import { useSessionApi } from './SessionContext'
import { useAppState, useAppStore, useTheme } from './StoreContext'
import { localDate } from './localTime'

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
    case 'message':
      return '✉'
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
  return localDate(new Date(t).toISOString())
}

const VISIBLE_ROWS = 14

// One account's items. `alias` is set only when grouped (several accounts).
type Group = { ref: AccountRef; alias?: string; tenant: string; items: ActivityItem[] }
type Entry = { item: ActivityItem; group: Group }
// A rendered line: an account header (grouped only) or the entry at `index`.
type Row = { header: Group } | { entry: Entry; index: number }

export function ActivityModal() {
  const { exit } = useApp()
  const store = useAppStore()
  const session = useSessionApi()
  const modal = useAppState((s) => s.modal)
  const account = useAppState((s) => s.account)
  const activityFeed = useAppState((s) => s.activityFeed)
  const me = useAppState((s) => s.me)
  const backgroundAccounts = useAppState((s) => s.backgroundAccounts)
  const aliases = useAppState((s) => s.settings.accounts)
  const theme = useTheme()
  const isOpen = modal?.kind === 'activity'
  const cursor = isOpen ? modal.cursor : 0

  // Grouped when two or more accounts are open (the unified sidebar's
  // condition), in its order; otherwise the foreground's feed, no header.
  const { grouped, groups } = useMemo(() => {
    const open: Group[] = aliases.flatMap((alias) => {
      const ref = accountRef(alias)
      const slice = account?.id === ref.id ? { activityFeed, me } : backgroundAccounts[ref.id]
      if (!slice) return []
      return [
        {
          ref,
          alias,
          tenant: tenantSuffix(slice.me?.userPrincipalName),
          items: slice.activityFeed,
        },
      ]
    })
    if (open.length > 1) return { grouped: true, groups: open.filter((g) => g.items.length > 0) }
    const single: Group[] = account ? [{ ref: account, tenant: '', items: activityFeed }] : []
    return { grouped: false, groups: single }
  }, [aliases, account, activityFeed, me, backgroundAccounts])

  // The cursor indexes entries across groups, so headers are never stops.
  const { entries, rows } = useMemo(() => {
    const entries: Entry[] = []
    const rows: Row[] = []
    for (const group of groups) {
      if (grouped) rows.push({ header: group })
      for (const item of group.items) {
        const entry = { item, group }
        rows.push({ entry, index: entries.length })
        entries.push(entry)
      }
    }
    return { entries, rows }
  }, [grouped, groups])

  // On open, opportunistically refresh from the server so the user sees
  // any items that arrived between the last reconcile and now. Concurrent
  // mode: every running account, each through its own AccountStore.
  useEffect(() => {
    // No account at all (every account removed): nothing to refresh.
    if (!isOpen || !store.get().account) return
    const targets = session.concurrent
      ? session.running().map((ref) => accountStoreFor(store, ref))
      : [accountStore(store)]
    for (const target of targets) void refreshActivityFeed(target)
  }, [isOpen, store, session])

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
        const next = Math.min(entries.length - 1, cursor + 1)
        store.set({ modal: { kind: 'activity', cursor: next } })
        return
      }
      if (ch === 'k' || key.upArrow) {
        const next = Math.max(0, cursor - 1)
        store.set({ modal: { kind: 'activity', cursor: next } })
        return
      }
      if (ch === 'a') {
        // Mark all as read locally, in every account shown.
        for (const g of groups) markAccountActivityRead(accountStoreFor(store, g.ref), 'all')
        return
      }
      const entry = entries[cursor]
      if (key.return && entry) {
        const { item, group } = entry
        markAccountActivityRead(accountStoreFor(store, group.ref), [item.id])
        const chatId = item.chatId
        // Open the source chat. Channel ids end in @thread.tacv2; without a
        // channel/team mapping at hand such an item (or one without a
        // chatId) is only marked read. Channel jump is left as a follow-up.
        // Unknown chats surface through the list/realtime reconcile.
        if (!chatId || chatId.includes('@thread.tacv2')) return
        // Another account's item: its account comes to the front first, as
        // when the unified sidebar opens one of its rows. Stops if that put
        // up the auth-expired modal.
        const toForeground = (alias: string) => session.setForeground(alias, { restoreUi: false })
        if (!bringToFront(store, group.alias, toForeground)) return
        store.set({ focus: { kind: 'chat', chatId }, modal: null, inputZone: 'list' })
      }
    },
    { isActive: isOpen },
  )

  if (!isOpen) return null

  // Sliding window over the rendered rows, keeping the cursor's in view.
  const cursorRow = rows.findIndex((r) => 'entry' in r && r.index === cursor)
  const top = Math.max(
    0,
    Math.min(rows.length - VISIBLE_ROWS, cursorRow - Math.floor(VISIBLE_ROWS / 2)),
  )
  const visible = rows.slice(top, top + VISIBLE_ROWS)
  const now = Date.now()
  const totalUnread = entries.filter((e) => !e.item.isRead).length

  return (
    <Box alignItems="center" justifyContent="center" flexGrow={1}>
      <Box
        flexDirection="column"
        borderStyle={inkBorder(theme.borders.modal)}
        borderColor={theme.borderActive}
        backgroundColor={modalBg(theme)}
        paddingX={theme.layout.modalPaddingX}
        paddingY={theme.layout.modalPaddingY}
        width={86}
        maxWidth="100%"
      >
        <Text bold={theme.emphasis.modalTitleBold}>
          Notifications
          {totalUnread > 0 ? ` (${totalUnread} unread)` : ''}
        </Text>
        <Box height={1} />
        {entries.length === 0 ? (
          <Text muted>(no notifications)</Text>
        ) : (
          visible.map((row) => {
            if ('header' in row) {
              const { ref, tenant } = row.header
              return (
                <Text key={`account:${ref.id}`}>
                  <Text bold>{ref.label}</Text>
                  <Text muted>{tenant}</Text>
                </Text>
              )
            }
            const it = row.entry.item
            const focused = row.index === cursor
            const arrow = focused ? '>' : ' '
            const sender = fitCells(it.senderDisplayName ?? '?', 18)
            const preview = fitCells(it.preview ?? '', 40)
            const when = relativeTime(it.createdAt, now).padStart(4)
            const unreadDot = it.isRead ? ' ' : '●'
            return (
              <Text key={`${row.entry.group.ref.id}/${it.id}`}>
                <Text color={theme.selected}>{arrow} </Text>
                <Text color={theme.warnText}>{unreadDot} </Text>
                <Text>{kindGlyph(it.kind)} </Text>
                <Text bold={focused}>{sender}</Text>
                <Text> </Text>
                <Text muted>{preview}</Text>
                <Text muted> {when}</Text>
              </Text>
            )
          })
        )}
        <Box height={1} />
        <Text muted>j/k: move · enter: open · a: mark all read · esc: close</Text>
      </Box>
    </Box>
  )
}
