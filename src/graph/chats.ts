// Chat (1:1, group, meeting) endpoints.
//
// Critical invariants:
//   - $orderby=lastMessagePreview/createdDateTime desc  (NOT lastUpdatedDateTime)
//   - $top capped at 50 by Graph for /chats/{id}/messages
//   - Older-page paging uses $filter=createdDateTime lt {iso} matching the
//     $orderby property; mismatched filter+orderby returns 400
//   - Member expansion is capped at 25 so we hydrate lazily, only on
//     visible/active chats

import { graph } from './client'
import type { Chat, ChatMessage, DirectoryUser, Person } from '../types'

type CollectionResponse<T> = { value: T[]; '@odata.nextLink'?: string }

const MESSAGES_TOP_DEFAULT = 50
const CHATS_TOP_DEFAULT = 50
const SEARCH_TOP_DEFAULT = 10

export type ListChatsOpts = {
  top?: number
  signal?: AbortSignal
}

export async function listChats(opts?: ListChatsOpts): Promise<Chat[]> {
  const top = opts?.top ?? CHATS_TOP_DEFAULT
  const res = await graph<CollectionResponse<Chat>>({
    method: 'GET',
    path: '/chats',
    query: {
      $expand: 'lastMessagePreview',
      $top: top,
      $orderby: 'lastMessagePreview/createdDateTime desc',
    },
    signal: opts?.signal,
  })
  return res.value
}

export type GetChatOpts = {
  members?: boolean
  signal?: AbortSignal
}

export async function getChat(chatId: string, opts?: GetChatOpts): Promise<Chat> {
  return graph<Chat>({
    method: 'GET',
    path: `/chats/${encodeURIComponent(chatId)}`,
    query: opts?.members ? { $expand: 'members' } : undefined,
    signal: opts?.signal,
  })
}

export type ListMessagesOpts = {
  top?: number
  // ISO 8601 timestamp; returns messages strictly older than this. Pass the
  // createdDateTime of the oldest currently-rendered message to load the
  // next older page.
  beforeCreatedDateTime?: string
  signal?: AbortSignal
}

export type MessagesPage = {
  messages: ChatMessage[]
  nextLink?: string
}

// Returns chat messages in chronological order (oldest first), so the UI
// can append in render order without re-sorting. Graph returns descending
// by createdDateTime; this helper reverses the slice before returning.
export async function listMessages(
  chatId: string,
  opts?: ListMessagesOpts,
): Promise<ChatMessage[]> {
  return (await listMessagesPage(chatId, opts)).messages
}

export async function listMessagesPage(
  chatId: string,
  opts?: ListMessagesOpts,
): Promise<MessagesPage> {
  const query: Record<string, string | number | undefined> = {
    $top: opts?.top ?? MESSAGES_TOP_DEFAULT,
    $orderby: 'createdDateTime desc',
  }
  if (opts?.beforeCreatedDateTime) {
    query.$filter = `createdDateTime lt ${opts.beforeCreatedDateTime}`
  }
  const res = await graph<CollectionResponse<ChatMessage>>({
    method: 'GET',
    path: `/chats/${encodeURIComponent(chatId)}/messages`,
    query,
    signal: opts?.signal,
  })
  return {
    messages: res.value.slice().reverse(),
    nextLink: res['@odata.nextLink'],
  }
}

export async function listMessagesNextPage(
  nextLink: string,
  opts?: { signal?: AbortSignal },
): Promise<MessagesPage> {
  const res = await graph<CollectionResponse<ChatMessage>>({
    method: 'GET',
    path: nextLink,
    signal: opts?.signal,
  })
  return {
    messages: res.value.slice().reverse(),
    nextLink: res['@odata.nextLink'],
  }
}

export type SendMessageOpts = {
  signal?: AbortSignal
}

export async function sendMessage(
  chatId: string,
  content: string,
  opts?: SendMessageOpts,
): Promise<ChatMessage> {
  return graph<ChatMessage>({
    method: 'POST',
    path: `/chats/${encodeURIComponent(chatId)}/messages`,
    body: { body: { contentType: 'text', content } },
    signal: opts?.signal,
  })
}

export type SearchPeopleOpts = {
  top?: number
  signal?: AbortSignal
}

function normalizedSearchQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ')
}

function graphSearchPhrase(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function graphSearchField(field: string, value: string): string {
  return `"${field}:${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export async function searchPeople(query: string, opts?: SearchPeopleOpts): Promise<Person[]> {
  const q = normalizedSearchQuery(query)
  if (!q) return []
  const res = await graph<CollectionResponse<Person>>({
    method: 'GET',
    path: '/me/people',
    query: {
      $search: graphSearchPhrase(q),
      $top: opts?.top ?? SEARCH_TOP_DEFAULT,
      $select:
        'id,displayName,userPrincipalName,scoredEmailAddresses,jobTitle,department,officeLocation',
    },
    signal: opts?.signal,
  })
  return res.value
}

export type SearchUsersOpts = {
  top?: number
  signal?: AbortSignal
}

export async function searchUsers(query: string, opts?: SearchUsersOpts): Promise<DirectoryUser[]> {
  const q = normalizedSearchQuery(query)
  if (!q) return []
  const res = await graph<CollectionResponse<DirectoryUser>>({
    method: 'GET',
    path: '/users',
    headers: { ConsistencyLevel: 'eventual' },
    query: {
      $search: [
        graphSearchField('displayName', q),
        graphSearchField('mail', q),
        graphSearchField('userPrincipalName', q),
      ].join(' OR '),
      $count: 'true',
      $top: opts?.top ?? SEARCH_TOP_DEFAULT,
      $select: 'id,displayName,userPrincipalName,mail,jobTitle,department,officeLocation',
    },
    signal: opts?.signal,
  })
  return res.value
}

function personKeys(person: Person): string[] {
  const keys = new Set<string>()
  if (person.userPrincipalName) keys.add(person.userPrincipalName.toLowerCase())
  for (const email of person.scoredEmailAddresses ?? []) {
    if (email.address) keys.add(email.address.toLowerCase())
  }
  return [...keys]
}

function userKeys(user: DirectoryUser): string[] {
  return [user.id, user.userPrincipalName, user.mail]
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .map((x) => x.toLowerCase())
}

function userRelevanceRank(user: DirectoryUser, relevance: Map<string, number>): number {
  let best = Number.MAX_SAFE_INTEGER
  for (const key of userKeys(user)) {
    best = Math.min(best, relevance.get(key) ?? Number.MAX_SAFE_INTEGER)
  }
  return best
}

export type SearchChatUsersOpts = {
  top?: number
  signal?: AbortSignal
}

export async function searchChatUsers(
  query: string,
  opts?: SearchChatUsersOpts,
): Promise<DirectoryUser[]> {
  const q = normalizedSearchQuery(query)
  if (!q) return []
  const [people, users] = await Promise.all([searchPeople(q, opts), searchUsers(q, opts)])
  const relevance = new Map<string, number>()
  people.forEach((person, index) => {
    for (const key of personKeys(person)) {
      if (!relevance.has(key)) relevance.set(key, index)
    }
  })
  return users.slice().sort((a, b) => {
    const aRank = userRelevanceRank(a, relevance)
    const bRank = userRelevanceRank(b, relevance)
    return aRank - bRank
  })
}

export type CreateChatOpts = {
  signal?: AbortSignal
}

type AadConversationMember = {
  '@odata.type': '#microsoft.graph.aadUserConversationMember'
  roles: string[]
  'user@odata.bind': string
}

function uniqueUserIds(userIds: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of userIds) {
    const userId = raw.trim()
    if (!userId || seen.has(userId)) continue
    seen.add(userId)
    out.push(userId)
  }
  return out
}

function odataString(value: string): string {
  return value.replace(/'/g, "''")
}

function aadMember(userId: string): AadConversationMember {
  return {
    '@odata.type': '#microsoft.graph.aadUserConversationMember',
    roles: ['owner'],
    'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${odataString(userId)}')`,
  }
}

async function createChat(
  chatType: 'oneOnOne' | 'group',
  memberUserIds: string[],
  opts?: CreateChatOpts & { topic?: string },
): Promise<Chat> {
  const members = uniqueUserIds(memberUserIds)
  if (chatType === 'oneOnOne' && members.length !== 2) {
    throw new Error('createOneOnOneChat requires exactly two user IDs including self')
  }
  if (chatType === 'group' && members.length < 3) {
    throw new Error('createGroupChat requires at least three user IDs including self')
  }
  return graph<Chat>({
    method: 'POST',
    path: '/chats',
    body: {
      chatType,
      ...(chatType === 'group' && opts?.topic ? { topic: opts.topic } : {}),
      members: members.map(aadMember),
    },
    signal: opts?.signal,
  })
}

export async function createOneOnOneChat(
  selfUserId: string,
  otherUserId: string,
  opts?: CreateChatOpts,
): Promise<Chat> {
  return createChat('oneOnOne', [selfUserId, otherUserId], opts)
}

export type CreateGroupChatOpts = CreateChatOpts & {
  topic?: string
}

export async function createGroupChat(
  memberUserIds: string[],
  opts?: CreateGroupChatOpts,
): Promise<Chat> {
  return createChat('group', memberUserIds, opts)
}
