import type { ChatMessage } from '../types'

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
