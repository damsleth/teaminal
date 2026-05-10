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

import { graph, paginate } from './client'
import {
  listChannelMessagesViaChatsvc,
  listChannelMessagesViaChatsvcNextPage,
  sendChannelMessageViaChatsvc,
} from './teamsChatsvc'
import type { Channel, ChannelMessage, Team } from '../types'

type CollectionResponse<T> = { value: T[]; '@odata.nextLink'?: string }

const CHANNEL_MESSAGES_TOP_DEFAULT = 50

// Channel message endpoints under Microsoft Graph require
// ChannelMessage.Read.All / ChannelMessage.Send. owa-piggy / FOCI never
// issues those scopes (they're not in the OWA token's consented set,
// and AADSTS65002 blocks the explicit upgrade), so we don't try Graph
// at all - reads, sends, and replies always go through the Teams chat
// service. The constants below are kept for documentation only.
export const CHANNEL_MESSAGE_READ_SCOPE = 'https://graph.microsoft.com/ChannelMessage.Read.All'
export const CHANNEL_MESSAGE_SEND_SCOPE = 'https://graph.microsoft.com/ChannelMessage.Send'

// Test compatibility shim - the previous Graph fallback flag is no
// longer needed but tests still call the reset helper.
export function __resetChannelReadFallbackForTests(): void {
  /* nothing to reset - chatsvc is the only path */
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
  _teamId: string,
  channelId: string,
  opts?: ListChannelMessagesOpts,
): Promise<ChannelMessagesPage> {
  // Graph would 403 with "Missing scope permissions on the request.
  // API requires one of 'ChannelMessage.Read.All'" because owa-piggy /
  // FOCI cannot mint that scope from the OWA refresh token. Always go
  // through the Teams chat service.
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
  const fallback = await listChannelMessagesViaChatsvcNextPage(nextLink, { signal: opts?.signal })
  return { messages: fallback.messages, nextLink: fallback.backwardLink }
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
  _teamId: string,
  channelId: string,
  content: string,
  opts?: SendChannelMessageOpts,
): Promise<ChannelMessage> {
  // Graph send needs ChannelMessage.Send which FOCI never issues.
  // Route through chatsvc unconditionally.
  return sendChannelMessageViaChatsvc(channelId, content, { signal: opts?.signal })
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
  _teamId: string,
  channelId: string,
  rootId: string,
  content: string,
  opts?: SendChannelMessageOpts,
): Promise<ChannelMessage> {
  return sendChannelMessageViaChatsvc(channelId, content, {
    replyToId: rootId,
    signal: opts?.signal,
  })
}
