import type { ChatMessage } from '../types'
import type { ReactionDisplayMode } from '../state/store'
import { htmlToText } from './html'
import { reactionsSummary } from './reactions'

export type LoadMoreState = 'idle' | 'loading' | 'error' | 'unavailable'

export type MessagePageState = {
  hasOlder: boolean
  loading: boolean
  fullyLoaded: boolean
  error?: string
}

export type MessageRenderRow =
  | { kind: 'loadMore'; state: LoadMoreState; label: string }
  | { kind: 'date'; key: string; label: string }
  | { kind: 'message'; key: string; message: ChatMessage }

export type MessageRowHeightOpts = {
  focusedMessageId?: string | null
  reactionDisplayMode?: ReactionDisplayMode
  messageTextColumns?: number
}

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
    fullyLoaded: meta.fullyLoaded === true,
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

export function messageRenderRowHeight(row: MessageRenderRow, opts?: MessageRowHeightOpts): number {
  if (row.kind !== 'message') return 1
  let height = estimateWrappedRows(messageTextForHeight(row, opts), opts?.messageTextColumns)
  if (row.message._sendError) height++
  return height
}

export function defaultMessageRowsWindowStart(
  rows: MessageRenderRow[],
  rowBudget: number,
  opts?: MessageRowHeightOpts,
): number {
  const budget = Math.max(1, rowBudget)
  let start = rows.length
  let used = 0
  while (start > 0) {
    const nextHeight = messageRenderRowHeight(rows[start - 1]!, opts)
    if (used > 0 && used + nextHeight > budget) break
    start--
    used += nextHeight
    if (used >= budget) break
  }
  return Math.max(0, start)
}

export function messageRowsWindowEnd(
  rows: MessageRenderRow[],
  start: number,
  opts: MessageRowHeightOpts & { rowBudget: number },
): number {
  const budget = Math.max(1, opts.rowBudget)
  let end = Math.max(0, Math.min(start, rows.length))
  let used = 0
  while (end < rows.length) {
    const nextHeight = messageRenderRowHeight(rows[end]!, opts)
    if (used > 0 && used + nextHeight > budget) break
    end++
    used += nextHeight
    if (used >= budget) break
  }
  return end
}

export function chooseMessageRowsWindowStart(
  rows: MessageRenderRow[],
  opts: MessageRowHeightOpts & {
    focusActive?: boolean
    rowBudget: number
    previousStart?: number
  },
): number {
  if (rows.length === 0) return 0
  const focusedRowIndex =
    opts.focusActive && opts.focusedMessageId
      ? rows.findIndex((row) => row.kind === 'message' && row.message.id === opts.focusedMessageId)
      : -1
  if (focusedRowIndex < 0) return defaultMessageRowsWindowStart(rows, opts.rowBudget, opts)

  const previousStart =
    opts.previousStart === undefined
      ? defaultMessageRowsWindowStart(rows, opts.rowBudget, opts)
      : Math.max(0, Math.min(opts.previousStart, rows.length - 1))
  const previousEnd = messageRowsWindowEnd(rows, previousStart, opts)
  if (focusedRowIndex >= previousStart && focusedRowIndex < previousEnd) return previousStart
  if (focusedRowIndex < previousStart) return focusedRowIndex

  const budget = Math.max(1, opts.rowBudget)
  let start = focusedRowIndex + 1
  let used = 0
  while (start > 0) {
    const nextHeight = messageRenderRowHeight(rows[start - 1]!, opts)
    if (used > 0 && used + nextHeight > budget) break
    start--
    used += nextHeight
    if (used >= budget) break
  }
  return start
}

export function sliceMessageRowsToBudget(
  rows: MessageRenderRow[],
  opts: MessageRowHeightOpts & {
    focusActive?: boolean
    rowBudget: number
    previousStart?: number
  },
): MessageRenderRow[] {
  if (rows.length === 0) return []
  const start = chooseMessageRowsWindowStart(rows, opts)
  const end = messageRowsWindowEnd(rows, start, opts)

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

function messageTextForHeight(row: MessageRenderRow, opts?: MessageRowHeightOpts): string {
  if (row.kind !== 'message') return ''
  const message = row.message
  let text = ''
  if (message.deletedDateTime) {
    const senderName = message.from?.user?.displayName ?? 'someone'
    const time = message.createdDateTime.slice(11, 16)
    text = `(message deleted by ${senderName} · ${time})`
  } else if (message.body.contentType === 'text') {
    text = (message.body.content ?? '').replace(/\s+/g, ' ').trim()
  } else {
    text = htmlToText(message.body.content ?? '')
  }
  if (!message.deletedDateTime && isHeightEdited(message)) text += ' (edited)'
  if (shouldShowReactionRow(row, opts)) {
    const reactions = reactionsSummary(message.reactions)
    if (reactions) text += ` (${reactions})`
  }
  return text || ' '
}

function estimateWrappedRows(text: string, columns = 80): number {
  const width = Math.max(1, columns)
  return text
    .split('\n')
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(Array.from(line).length / width)), 0)
}

const HEIGHT_EDITED_GRACE_MS = 5_000

function isHeightEdited(message: ChatMessage): boolean {
  if (!message.lastModifiedDateTime) return false
  const created = Date.parse(message.createdDateTime)
  const modified = Date.parse(message.lastModifiedDateTime)
  if (!Number.isFinite(created) || !Number.isFinite(modified)) return false
  return modified - created > HEIGHT_EDITED_GRACE_MS
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
