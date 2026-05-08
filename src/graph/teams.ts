// Joined teams + channel + channel-message endpoints.
//
// Critical limits under delegated auth:
//   - /me/joinedTeams rejects $top and $select - any unsupported query
//     parameter returns HTTP 400 ("Query option ... is not allowed")
//   - Channel message listing supports $top but no useful $orderby or
//     $filter - older pages MUST be fetched via @odata.nextLink
//   - Replies/threads are out of scope for v1; the listChannelMessages
//     return value contains root messages only
//   - /me/joinedTeams does NOT include host teams for shared channels
//     where the user is only a shared-channel member; shared-channel
//     discovery is parked for after v1

import { recordEvent } from '../log'
import { graph, GraphError, paginate } from './client'
import {
  listChannelMessagesViaChatsvc,
  listChannelMessagesViaChatsvcNextPage,
} from './teamsChatsvc'
import type { Channel, ChannelMessage, Team } from '../types'

type CollectionResponse<T> = { value: T[]; '@odata.nextLink'?: string }

const CHANNEL_MESSAGES_TOP_DEFAULT = 50
export const CHANNEL_MESSAGE_READ_SCOPE = 'https://graph.microsoft.com/ChannelMessage.Read.All'
export const CHANNEL_MESSAGE_SEND_SCOPE = 'https://graph.microsoft.com/ChannelMessage.Send'

// Latched once Graph rejects channel message reads in this session
// (typically tenants without ChannelMessage.Read.All preauth on the
// Teams Web app id). All subsequent reads go straight to the chatsvc
// fallback without re-trying Graph.
let graphChannelReadsBlocked = false

function isMissingScopeError(err: unknown): boolean {
  if (!(err instanceof GraphError)) return false
  if (err.status !== 403) return false
  return /missing\s+scope|ChannelMessage\.Read\.All/i.test(err.message)
}

export function __resetChannelReadFallbackForTests(): void {
  graphChannelReadsBlocked = false
}

function noteFallbackOnce(reason: string): void {
  if (graphChannelReadsBlocked) return
  graphChannelReadsBlocked = true
  recordEvent(
    'graph',
    'warn',
    `channel reads via Graph blocked (${reason}); falling back to Teams chatsvc for the rest of this session`,
  )
}

export type ListJoinedTeamsOpts = {
  signal?: AbortSignal
}

export async function listJoinedTeams(opts?: ListJoinedTeamsOpts): Promise<Team[]> {
  // Intentionally no $select/$top - Graph rejects them under delegated auth
  // for /me/joinedTeams (returns 400 "Query option ... is not allowed").
  const res = await graph<CollectionResponse<Team>>({
    method: 'GET',
    path: '/me/joinedTeams',
    signal: opts?.signal,
  })
  return res.value
}

export type ListChannelsOpts = {
  signal?: AbortSignal
}

export async function listChannels(teamId: string, opts?: ListChannelsOpts): Promise<Channel[]> {
  const res = await graph<CollectionResponse<Channel>>({
    method: 'GET',
    path: `/teams/${encodeURIComponent(teamId)}/channels`,
    query: { $select: 'id,displayName,description,membershipType,isArchived' },
    signal: opts?.signal,
  })
  return res.value
}

export type ListChannelMessagesOpts = {
  top?: number
  signal?: AbortSignal
}

export type ChannelMessagesPage = {
  messages: ChannelMessage[]
  nextLink?: string
}

// Returns root channel messages in chronological order (oldest first), so
// the UI can append in render order without re-sorting. Graph returns
// descending by lastModifiedDateTime; this helper reverses before returning.
//
// Replies/threads are NOT included - that's the documented v1 limit; load
// older pages with `paginateChannelMessages`.
export async function listChannelMessages(
  teamId: string,
  channelId: string,
  opts?: ListChannelMessagesOpts,
): Promise<ChannelMessage[]> {
  return (await listChannelMessagesPage(teamId, channelId, opts)).messages
}

export async function listChannelMessagesPage(
  teamId: string,
  channelId: string,
  opts?: ListChannelMessagesOpts,
): Promise<ChannelMessagesPage> {
  if (!graphChannelReadsBlocked) {
    try {
      const res = await graph<CollectionResponse<ChannelMessage>>({
        method: 'GET',
        path: `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`,
        query: { $top: opts?.top ?? CHANNEL_MESSAGES_TOP_DEFAULT },
        scope: CHANNEL_MESSAGE_READ_SCOPE,
        signal: opts?.signal,
      })
      return {
        messages: res.value.slice().reverse(),
        nextLink: res['@odata.nextLink'],
      }
    } catch (err) {
      if (!isMissingScopeError(err)) throw err
      noteFallbackOnce('Graph 403 missing ChannelMessage.Read.All')
    }
  }
  const fallback = await listChannelMessagesViaChatsvc(channelId, {
    pageSize: opts?.top ?? CHANNEL_MESSAGES_TOP_DEFAULT,
    signal: opts?.signal,
  })
  return { messages: fallback.messages, nextLink: fallback.backwardLink }
}

export async function listChannelMessagesNextPage(
  nextLink: string,
  opts?: { signal?: AbortSignal },
): Promise<ChannelMessagesPage> {
  // chatsvc backward links live on teams.microsoft.com; Graph nextLinks
  // live on graph.microsoft.com. Route by hostname so we never send a
  // chatsvc URL through the Graph wrapper (and vice versa).
  if (nextLink.includes('teams.microsoft.com')) {
    const fallback = await listChannelMessagesViaChatsvcNextPage(nextLink, { signal: opts?.signal })
    return { messages: fallback.messages, nextLink: fallback.backwardLink }
  }
  const res = await graph<CollectionResponse<ChannelMessage>>({
    method: 'GET',
    path: nextLink,
    scope: CHANNEL_MESSAGE_READ_SCOPE,
    signal: opts?.signal,
  })
  return {
    messages: res.value.slice().reverse(),
    nextLink: res['@odata.nextLink'],
  }
}

// AsyncGenerator of channel-message pages following @odata.nextLink. Each
// yielded page is in API (descending) order; reverse per page if rendering
// chronologically. Use sparingly - paging an active channel from the top
// repeatedly is wasteful; v1 only pages on explicit "load older" intents.
export function paginateChannelMessages(
  teamId: string,
  channelId: string,
  opts?: ListChannelMessagesOpts,
): AsyncGenerator<ChannelMessage[], void, unknown> {
  return paginate<ChannelMessage>({
    method: 'GET',
    path: `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`,
    query: { $top: opts?.top ?? CHANNEL_MESSAGES_TOP_DEFAULT },
    scope: CHANNEL_MESSAGE_READ_SCOPE,
    signal: opts?.signal,
  })
}

export type SendChannelMessageOpts = {
  signal?: AbortSignal
}

export async function sendChannelMessage(
  teamId: string,
  channelId: string,
  content: string,
  opts?: SendChannelMessageOpts,
): Promise<ChannelMessage> {
  return graph<ChannelMessage>({
    method: 'POST',
    path: `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`,
    body: { body: { contentType: 'text', content } },
    scope: CHANNEL_MESSAGE_SEND_SCOPE,
    signal: opts?.signal,
  })
}

// --- Channel replies (threaded messages) ---
//
// Each root message in a channel may have replies hanging off it. The
// list endpoint supports $top and pagination via @odata.nextLink, but
// orderBy/filter shapes are limited under delegated auth. Replies arrive
// in the same descending order as root messages; we reverse for render
// parity with listChannelMessagesPage.

export type ListChannelRepliesOpts = {
  top?: number
  signal?: AbortSignal
}

export type ChannelRepliesPage = {
  messages: ChannelMessage[]
  nextLink?: string
}

const CHANNEL_REPLIES_TOP_DEFAULT = 50

export async function listChannelReplies(
  teamId: string,
  channelId: string,
  rootId: string,
  opts?: ListChannelRepliesOpts,
): Promise<ChannelMessage[]> {
  return (await listChannelRepliesPage(teamId, channelId, rootId, opts)).messages
}

export async function listChannelRepliesPage(
  teamId: string,
  channelId: string,
  rootId: string,
  opts?: ListChannelRepliesOpts,
): Promise<ChannelRepliesPage> {
  const res = await graph<CollectionResponse<ChannelMessage>>({
    method: 'GET',
    path: `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(rootId)}/replies`,
    query: { $top: opts?.top ?? CHANNEL_REPLIES_TOP_DEFAULT },
    scope: CHANNEL_MESSAGE_READ_SCOPE,
    signal: opts?.signal,
  })
  return {
    messages: res.value.slice().reverse(),
    nextLink: res['@odata.nextLink'],
  }
}

export async function listChannelRepliesNextPage(
  nextLink: string,
  opts?: { signal?: AbortSignal },
): Promise<ChannelRepliesPage> {
  const res = await graph<CollectionResponse<ChannelMessage>>({
    method: 'GET',
    path: nextLink,
    scope: CHANNEL_MESSAGE_READ_SCOPE,
    signal: opts?.signal,
  })
  return {
    messages: res.value.slice().reverse(),
    nextLink: res['@odata.nextLink'],
  }
}

/**
 * Post a reply to a channel root message.
 *
 * Caller must have a valid root message id (from a previous channel
 * messages fetch). The returned ChannelMessage has the canonical id and
 * `replyToId` set to the root.
 */
export async function postChannelReply(
  teamId: string,
  channelId: string,
  rootId: string,
  content: string,
  opts?: SendChannelMessageOpts,
): Promise<ChannelMessage> {
  return graph<ChannelMessage>({
    method: 'POST',
    path: `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(rootId)}/replies`,
    body: { body: { contentType: 'text', content } },
    scope: CHANNEL_MESSAGE_SEND_SCOPE,
    signal: opts?.signal,
  })
}
