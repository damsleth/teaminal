import type { ChatMessage } from '../types'
import type { ReactionDisplayMode } from '../state/store'
import { reactionsSummary } from './reactions'

export type LoadMoreState = 'idle' | 'loading' | 'error' | 'unavailable'

export type MessagePageState = {
  hasOlder: boolean
  loading: boolean
  error?: string
}

export type MessageRenderRow =
  | { kind: 'loadMore'; state: LoadMoreState; label: string }
  | { kind: 'date'; key: string; label: string }
  | { kind: 'message'; key: string; message: ChatMessage }

type MessagePageMeta = Partial<{
  messages: ChatMessage[]
  nextLink: string
  olderNextLink: string
  hasOlder: boolean
  loadingOlder: boolean
  fullyLoaded: boolean
  error: string
  loadOlderError: string
}>

export function readMessagePageState(source: ChatMessage[] | MessagePageMeta): MessagePageState {
  const meta = source as MessagePageMeta
  return {
    hasOlder: Boolean(
      meta.hasOlder || ((meta.nextLink || meta.olderNextLink) && !meta.fullyLoaded),
    ),
    loading: meta.loadingOlder === true,
    error: meta.loadOlderError ?? meta.error,
  }
}

export function buildMessageRows(
  messages: ChatMessage[],
  opts?: {
    showLoadMoreRow?: boolean
    loadMoreState?: LoadMoreState
    now?: Date
  },
): MessageRenderRow[] {
  const rows: MessageRenderRow[] = []

  if (opts?.showLoadMoreRow) {
    const state = opts.loadMoreState ?? 'unavailable'
    rows.push({
      kind: 'loadMore',
      state,
      label: loadMoreLabel(state),
    })
  }

  let lastDateKey: string | null = null
  for (const message of messages) {
    const dateKey = message.createdDateTime.slice(0, 10)
    if (dateKey && dateKey !== lastDateKey) {
      rows.push({
        kind: 'date',
        key: `date-${dateKey}`,
        label: formatDateHeader(message.createdDateTime, opts?.now),
      })
      lastDateKey = dateKey
    }
    rows.push({ kind: 'message', key: message.id, message })
  }

  return rows
}

export function shouldShowReactionRow(
  row: MessageRenderRow,
  opts?: {
    reactionDisplayMode?: ReactionDisplayMode
    focusedMessageId?: string | null
  },
): boolean {
  if (row.kind !== 'message') return false
  if (row.message.deletedDateTime) return false
  if (!reactionsSummary(row.message.reactions)) return false
  const mode = opts?.reactionDisplayMode ?? 'all'
  if (mode === 'off') return false
  if (mode === 'current') return row.message.id === opts?.focusedMessageId
  return true
}

export function messageRenderRowHeight(
  row: MessageRenderRow,
  opts?: {
    reactionDisplayMode?: ReactionDisplayMode
    focusedMessageId?: string | null
  },
): number {
  if (row.kind !== 'message') return 1
  let height = 1
  if (shouldShowReactionRow(row, opts)) height++
  if (row.message._sendError) height++
  return height
}

export function sliceMessageRowsToBudget(
  rows: MessageRenderRow[],
  opts: {
    focusedMessageId?: string | null
    focusActive?: boolean
    reactionDisplayMode?: ReactionDisplayMode
    rowBudget: number
  },
): MessageRenderRow[] {
  if (rows.length === 0) return []
  const budget = Math.max(1, opts.rowBudget)
  const focusedRowIndex =
    opts.focusActive && opts.focusedMessageId
      ? rows.findIndex((row) => row.kind === 'message' && row.message.id === opts.focusedMessageId)
      : -1
  const endExclusive = focusedRowIndex >= 0 ? focusedRowIndex + 1 : rows.length

  let start = endExclusive
  let used = 0
  while (start > 0) {
    const nextHeight = messageRenderRowHeight(rows[start - 1]!, {
      reactionDisplayMode: opts.reactionDisplayMode,
      focusedMessageId: opts.focusedMessageId,
    })
    if (used > 0 && used + nextHeight > budget) break
    start--
    used += nextHeight
    if (used >= budget) break
  }

  let end = endExclusive
  while (used < budget && end < rows.length) {
    const nextHeight = messageRenderRowHeight(rows[end]!, {
      reactionDisplayMode: opts.reactionDisplayMode,
      focusedMessageId: opts.focusedMessageId,
    })
    if (used > 0 && used + nextHeight > budget) break
    end++
    used += nextHeight
  }

  return rows.slice(start, end)
}

function loadMoreLabel(state: LoadMoreState): string {
  switch (state) {
    case 'idle':
      return 'Load older messages'
    case 'loading':
      return 'Loading older messages...'
    case 'error':
      return 'Could not load older messages'
    case 'unavailable':
      return 'Older history unavailable until poller pagination is wired'
  }
}

function formatDateHeader(iso: string, now = new Date()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10)

  const today = startOfLocalDay(now)
  const target = startOfLocalDay(date)
  const diffDays = Math.round((today.getTime() - target.getTime()) / 86_400_000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'

  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  })
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}
