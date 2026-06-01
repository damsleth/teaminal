// userId -> resolved full display name, harvested from message senders.
//
// Why this exists: the chat list derives 1:1 / group labels from
// `chat.members[].displayName`, but Graph's conversationMember roster is
// an unreliable name source — for guests, federated peers, or members
// whose directory entry wasn't resolved when the roster was built, that
// field is either null (so chatLabel falls back to "(unknown)") or the
// raw email / UPN (so the email shows where a name should). Every
// message, by contrast, carries `from.user.displayName` already resolved
// to the person's real name.
//
// So we fold sender names from messages (and the cheap, all-chats
// lastMessagePreview.from) into a userId -> name index keyed by AAD
// object id — the same id space as ChatMember.userId — and let chatLabel
// prefer it over a missing-or-email roster name. The index is persisted
// alongside the message / list caches (see nameCachePersistence.ts).

import type { Chat, ChatMember, ChatMessage, DirectoryUser, IdentitySet } from '../types'

// A display name that is really just an email / UPN. We treat these as
// "not a real name" so a resolved name from the index can replace them.
export function looksLikeEmail(name: string | null | undefined): boolean {
  if (!name) return false
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(name.trim())
}

// Trimmed name we'd be happy to display, or null when it's empty or just
// an email address.
function usableName(name: string | null | undefined): string | null {
  if (!name) return null
  const trimmed = name.trim()
  if (!trimmed || looksLikeEmail(trimmed)) return null
  return trimmed
}

function senderName(from: IdentitySet): { id: string; name: string } | null {
  const user = from?.user
  if (!user?.id) return null
  const name = usableName(user.displayName)
  return name ? { id: user.id, name } : null
}

// Fold resolved sender names from a batch of messages into the index.
// Returns the SAME reference when nothing new was learned so store
// subscribers (and the cache writer) don't churn on every poll.
export function indexNamesFromMessages(
  existing: Record<string, string>,
  messages: readonly ChatMessage[],
): Record<string, string> {
  let next = existing
  for (const m of messages) {
    const s = m.from ? senderName(m.from) : null
    if (!s || next[s.id] === s.name) continue
    if (next === existing) next = { ...existing }
    next[s.id] = s.name
  }
  return next
}

// Fold names from the chat list itself: the all-chats lastMessagePreview
// sender (covers chats never opened) plus any usable member displayNames
// (so a good name seen in one chat backfills the same person elsewhere).
// Returns the same reference when nothing changed.
export function indexNamesFromChats(
  existing: Record<string, string>,
  chats: readonly Chat[],
): Record<string, string> {
  let next = existing
  const put = (id: string | null | undefined, raw: string | null | undefined): void => {
    const name = usableName(raw)
    if (!id || !name || next[id] === name) return
    if (next === existing) next = { ...existing }
    next[id] = name
  }
  for (const c of chats) {
    const preview = c.lastMessagePreview?.from?.user
    if (preview?.id) put(preview.id, preview.displayName)
    for (const m of c.members ?? []) put(m.userId, m.displayName)
  }
  return next
}

// Fold a directory user's resolved name into the index. Used when a chat is
// created from the people picker: the picked DirectoryUser carries a real
// displayName, but the freshly-created chat's roster often comes back with a
// null / email-shaped member name and no lastMessagePreview, so without this
// the new chat would render as email / "(unknown)" until the first message
// arrives. Returns the same reference when nothing changed.
export function indexNameFromDirectoryUser(
  existing: Record<string, string>,
  user: DirectoryUser,
): Record<string, string> {
  const name = usableName(user.displayName)
  if (!user.id || !name || existing[user.id] === name) return existing
  return { ...existing, [user.id]: name }
}

// Best display name for a chat member, preferring (1) a usable roster
// displayName, (2) the indexed name resolved from messages, (3) the raw
// roster displayName even if it's an email — still better than nothing.
// Returns null only when we truly have no string to show.
export function resolveMemberName(
  member: ChatMember | undefined,
  index?: Record<string, string>,
): string | null {
  if (!member) return null
  const direct = usableName(member.displayName)
  if (direct) return direct
  const looked = member.userId ? index?.[member.userId] : undefined
  if (looked) return looked
  const raw = member.displayName?.trim()
  return raw && raw.length > 0 ? raw : null
}
