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
import type { Channel, ChannelMessage, Team } from '../types'

type CollectionResponse<T> = { value: T[]; '@odata.nextLink'?: string }

const CHANNEL_MESSAGES_TOP_DEFAULT = 50

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
  const res = await graph<CollectionResponse<ChannelMessage>>({
    method: 'GET',
    path: `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`,
    query: { $top: opts?.top ?? CHANNEL_MESSAGES_TOP_DEFAULT },
    signal: opts?.signal,
  })
  return {
    messages: res.value.slice().reverse(),
    nextLink: res['@odata.nextLink'],
  }
}

export async function listChannelMessagesNextPage(
  nextLink: string,
  opts?: { signal?: AbortSignal },
): Promise<ChannelMessagesPage> {
  const res = await graph<CollectionResponse<ChannelMessage>>({
    method: 'GET',
    path: nextLink,
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
    signal: opts?.signal,
  })
}
