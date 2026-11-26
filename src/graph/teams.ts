// Joined teams + channel + channel-message endpoints.
//
// Critical limits under delegated auth:
//   - /me/joinedTeams rejects $top and $select - any unsupported query
//     parameter returns HTTP 400 ("Query option ... is not allowed")
//   - Channel message listing supports $top but no useful $orderby or
//     $filter - older pages MUST be fetched via @odata.nextLink
//   - Channel reads return the full stream (roots and replies
//     interleaved); src/state/channelThreads.ts groups it into threads
//   - /me/joinedTeams does NOT include host teams for shared channels
//     where the user is only a shared-channel member; shared-channel
//     discovery is parked for after v1

import type { GraphClient } from './client'
import {
  listChannelMessagesViaChatsvc,
  listChannelMessagesViaChatsvcNextPage,
  listChannelRepliesViaChatsvc,
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

export type ListJoinedTeamsOpts = {
  signal?: AbortSignal
}

export async function listJoinedTeams(
  client: GraphClient,
  opts?: ListJoinedTeamsOpts,
): Promise<Team[]> {
  // Intentionally no $select/$top - Graph rejects them under delegated auth
  // for /me/joinedTeams (returns 400 "Query option ... is not allowed").
  const res = await client.graph<CollectionResponse<Team>>({
    method: 'GET',
    path: '/me/joinedTeams',
    signal: opts?.signal,
  })
  return res.value
}

export type ListChannelsOpts = {
  signal?: AbortSignal
}

export async function listChannels(
  client: GraphClient,
  teamId: string,
  opts?: ListChannelsOpts,
): Promise<Channel[]> {
  const res = await client.graph<CollectionResponse<Channel>>({
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

// Returns the channel's message stream (roots and replies interleaved) in
// chronological order (oldest first), so the UI can append in render order
// without re-sorting. Older pages follow `nextLink` via
// `listChannelMessagesNextPage`.
export async function listChannelMessages(
  client: GraphClient,
  teamId: string,
  channelId: string,
  opts?: ListChannelMessagesOpts,
): Promise<ChannelMessage[]> {
  return (await listChannelMessagesPage(client, teamId, channelId, opts)).messages
}

export async function listChannelMessagesPage(
  client: GraphClient,
  _teamId: string,
  channelId: string,
  opts?: ListChannelMessagesOpts,
): Promise<ChannelMessagesPage> {
  // Graph would 403 with "Missing scope permissions on the request.
  // API requires one of 'ChannelMessage.Read.All'" because owa-piggy /
  // FOCI cannot mint that scope from the OWA refresh token. Always go
  // through the Teams chat service.
  const fallback = await listChannelMessagesViaChatsvc(channelId, {
    account: client.ctx.account,
    pageSize: opts?.top ?? CHANNEL_MESSAGES_TOP_DEFAULT,
    signal: opts?.signal,
  })
  return { messages: fallback.messages, nextLink: fallback.backwardLink }
}

export async function listChannelMessagesNextPage(
  client: GraphClient,
  nextLink: string,
  opts?: { signal?: AbortSignal },
): Promise<ChannelMessagesPage> {
  const fallback = await listChannelMessagesViaChatsvcNextPage(nextLink, {
    account: client.ctx.account,
    signal: opts?.signal,
  })
  return { messages: fallback.messages, nextLink: fallback.backwardLink }
}

export type SendChannelMessageOpts = {
  signal?: AbortSignal
  clientMessageId?: string
  // Sender stamped on the wire and on the returned row; chatsvc echoes no author.
  fromUserId?: string
  imdisplayname?: string
}

export async function sendChannelMessage(
  client: GraphClient,
  _teamId: string,
  channelId: string,
  content: string,
  opts?: SendChannelMessageOpts,
): Promise<ChannelMessage> {
  // Graph send needs ChannelMessage.Send which FOCI never issues.
  // Route through chatsvc unconditionally.
  return sendChannelMessageViaChatsvc(channelId, content, {
    account: client.ctx.account,
    signal: opts?.signal,
    clientMessageId: opts?.clientMessageId,
    fromUserId: opts?.fromUserId,
    imdisplayname: opts?.imdisplayname,
  })
}

// --- Channel replies (threaded messages) ---
//
// A thread is read via the chatsvc sub-conversation door
// (…/conversations/{channelId};messageid={rootId}/messages), NOT Graph
// /replies - the latter needs ChannelMessage.Read.All, which owa-piggy/FOCI
// never issues (403). The chatsvc door returns the root + its replies in
// chronological order; pagination follows the Skype backwardLink.

export type ListChannelRepliesOpts = {
  top?: number
  signal?: AbortSignal
}

export type ChannelRepliesPage = {
  messages: ChannelMessage[]
  nextLink?: string
}

const CHANNEL_REPLIES_TOP_DEFAULT = 50

export async function listChannelRepliesPage(
  client: GraphClient,
  _teamId: string,
  channelId: string,
  rootId: string,
  opts?: ListChannelRepliesOpts,
): Promise<ChannelRepliesPage> {
  const page = await listChannelRepliesViaChatsvc(channelId, rootId, {
    account: client.ctx.account,
    pageSize: opts?.top ?? CHANNEL_REPLIES_TOP_DEFAULT,
    signal: opts?.signal,
  })
  return { messages: page.messages, nextLink: page.backwardLink }
}

export async function listChannelRepliesNextPage(
  client: GraphClient,
  nextLink: string,
  opts?: { signal?: AbortSignal },
): Promise<ChannelRepliesPage> {
  // The Skype backwardLink is absolute; the generic chatsvc follower handles
  // both channel and thread (sub-conversation) pages.
  const page = await listChannelMessagesViaChatsvcNextPage(nextLink, {
    account: client.ctx.account,
    signal: opts?.signal,
  })
  return { messages: page.messages, nextLink: page.backwardLink }
}

/**
 * Post a reply to a channel root message.
 *
 * Caller must have a valid root message id (from a previous channel
 * messages fetch). The returned ChannelMessage has the canonical id and
 * `replyToId` set to the root.
 */
export async function postChannelReply(
  client: GraphClient,
  _teamId: string,
  channelId: string,
  rootId: string,
  content: string,
  opts?: SendChannelMessageOpts,
): Promise<ChannelMessage> {
  return sendChannelMessageViaChatsvc(channelId, content, {
    account: client.ctx.account,
    replyToId: rootId,
    signal: opts?.signal,
    clientMessageId: opts?.clientMessageId,
    fromUserId: opts?.fromUserId,
    imdisplayname: opts?.imdisplayname,
  })
}
