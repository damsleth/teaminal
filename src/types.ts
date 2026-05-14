// Domain types shared across modules.
//
// Field coverage is pragmatic: only the slices teaminal v1 actually reads.
// Add fields incrementally as the UI starts using them rather than
// translating the entire Graph schema up-front.

export type ChatType = 'oneOnOne' | 'group' | 'meeting' | 'unknownFutureValue'

export type MessageContentType = 'text' | 'html'

export type MessageBody = {
  contentType: MessageContentType
  content: string
}

export type IdentityUser = {
  id: string
  displayName?: string | null
  userIdentityType?: string
}

export type IdentitySet = {
  user?: IdentityUser | null
  application?: { id?: string; displayName?: string | null } | null
  device?: { id?: string; displayName?: string | null } | null
} | null

export type ChatMember = {
  id: string
  displayName?: string | null
  email?: string | null
  // Graph returns `userId` for AAD users in chat members
  userId?: string | null
  roles?: string[]
}

export type LastMessagePreview = {
  id: string
  createdDateTime: string
  isDeleted?: boolean
  messageType?: string
  body?: MessageBody
  from?: IdentitySet
}

export type Chat = {
  id: string
  topic?: string | null
  createdDateTime: string
  lastUpdatedDateTime?: string
  chatType: ChatType
  webUrl?: string
  // present only when GET /chats/{id}?$expand=members or specific listChats
  members?: ChatMember[]
  // present when listChats uses $expand=lastMessagePreview
  lastMessagePreview?: LastMessagePreview | null
}

export type Mention = {
  // Graph defines this as int but it's the position index of the mention
  // within the message body, not a stable ID
  id: number
  mentionText?: string
  mentioned?: IdentitySet
}

export type Reaction = {
  // Microsoft's documented short list, plus the open string for unknowns.
  reactionType: 'like' | 'heart' | 'laugh' | 'surprised' | 'sad' | 'angry' | 'custom' | string
  createdDateTime?: string
  user?: IdentitySet
  // Custom reactions carry a display name; non-custom usually don't.
  displayName?: string
}

// Graph attaches a typed `eventDetail` payload to systemEventMessage
// rows describing what happened (chat created, member added, call ended,
// meeting started, ...). Field coverage matches what we actually decode
// in src/ui/systemEvent.ts; unknown subtypes fall through to null.
export type SystemEventDetail = {
  '@odata.type'?: string
  initiator?: IdentitySet
  members?: { id?: string; displayName?: string | null }[]
  callDuration?: string
  callEventType?: string
  meetingOrganizer?: IdentitySet
  topic?: string | null
  // Future subtypes pass through opaquely.
  [key: string]: unknown
}

// Graph chat message attachment. contentType is the MIME type for file
// and image attachments, or a Teams-specific string (e.g.
// "application/vnd.microsoft.teams.file.download.info") for hosted
// content references. Only the fields teaminal reads are declared; Graph
// may include additional vendor fields.
export type MessageAttachment = {
  id: string
  contentType: string
  contentUrl?: string | null
  content?: string | null
  name?: string | null
  thumbnailUrl?: string | null
  teamsAppId?: string | null
}

// Parsed view of an attachment whose contentType is "messageReference".
// Graph stores the quoted message metadata as JSON in `attachment.content`;
// the body of the new message contains an `<attachment id="...">` tag
// referencing this attachment by id.
export type MessageReferenceContent = {
  messageId: string
  messageSender?: IdentitySet
  messageType?: string
  messagePreview?: string
  createdDateTime?: string
}

export function parseMessageReference(a: MessageAttachment): MessageReferenceContent | null {
  if (a.contentType !== 'messageReference') return null
  if (!a.content) return null
  try {
    const parsed = JSON.parse(a.content) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const obj = parsed as Record<string, unknown>
    const messageId = obj.messageId
    if (typeof messageId !== 'string') return null
    return {
      messageId,
      messageSender: obj.messageSender as IdentitySet | undefined,
      messageType: typeof obj.messageType === 'string' ? obj.messageType : undefined,
      messagePreview: typeof obj.messagePreview === 'string' ? obj.messagePreview : undefined,
      createdDateTime: typeof obj.createdDateTime === 'string' ? obj.createdDateTime : undefined,
    }
  } catch {
    return null
  }
}

// Image attachments come in two shapes:
//   1. contentType starts with 'image/' - direct file attachment
//   2. common image extension in the name - Teams hosted content (contentType
//      is often a Teams-specific string, not the image MIME type itself)
export function isImageAttachment(a: MessageAttachment): boolean {
  if (a.contentType.startsWith('image/')) return true
  const name = a.name ?? ''
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(name)
}

function hostedContentPath(chatId: string, messageId: string, attachmentId: string): string {
  return `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/hostedContents/${encodeURIComponent(attachmentId)}/$value`
}

const GRAPH_V1_BASE = 'https://graph.microsoft.com/v1.0'

// Return the Graph-relative path to download an image attachment.
// Prefers a contentUrl that already points into Graph; falls back to the
// hostedContents endpoint for inline-pasted images.
export function attachmentGraphPath(
  attachment: MessageAttachment,
  chatId: string,
  messageId: string,
): string {
  const url = attachment.contentUrl ?? ''
  if (url.startsWith(`${GRAPH_V1_BASE}/`)) return url.slice(GRAPH_V1_BASE.length)
  return hostedContentPath(chatId, messageId, attachment.id)
}

export type ChatMessage = {
  id: string
  createdDateTime: string
  lastModifiedDateTime?: string
  // Set on tombstone-style deletes returned by Graph in some channel
  // paths. The body content is empty when this is present.
  deletedDateTime?: string | null
  chatId?: string
  messageType?: 'message' | 'systemEventMessage' | 'unknownFutureValue' | string
  from?: IdentitySet
  body: MessageBody
  mentions?: Mention[]
  importance?: 'normal' | 'high' | 'urgent'
  attachments?: MessageAttachment[]
  reactions?: Reaction[]
  replyToId?: string | null
  subject?: string | null
  eventDetail?: SystemEventDetail | null
  // Local-only fields used by the optimistic-send flow. Underscore prefix
  // marks them as never set by Graph; they're always undefined on
  // server-confirmed messages. Once the server response replaces the
  // optimistic message, all three are absent.
  _tempId?: string
  _sending?: boolean
  _sendError?: string
}

export type ScoredEmailAddress = {
  address?: string | null
  relevanceScore?: number | null
  selectionLikelihood?: string | null
}

export type Person = {
  id: string
  displayName?: string | null
  userPrincipalName?: string | null
  scoredEmailAddresses?: ScoredEmailAddress[]
  jobTitle?: string | null
  department?: string | null
  officeLocation?: string | null
}

export type DirectoryUser = {
  id: string
  displayName?: string | null
  userPrincipalName?: string | null
  mail?: string | null
  jobTitle?: string | null
  department?: string | null
  officeLocation?: string | null
}

export type Team = {
  id: string
  displayName: string
  description?: string | null
  isArchived?: boolean
  createdDateTime?: string
  visibility?: 'private' | 'public' | 'hiddenMembership' | 'unknownFutureValue'
}

export type ChannelMembershipType = 'standard' | 'private' | 'shared' | 'unknownFutureValue'

export type Channel = {
  id: string
  displayName: string
  description?: string | null
  membershipType?: ChannelMembershipType
  isArchived?: boolean
  webUrl?: string
}

// Channel messages share the ChatMessage shape in Graph; reuse to avoid a
// near-duplicate type. The replyToId / subject fields on ChatMessage are
// the channel-specific extras.
export type ChannelMessage = ChatMessage

export type PresenceAvailability =
  | 'Available'
  | 'AvailableIdle'
  | 'Away'
  | 'BeRightBack'
  | 'Busy'
  | 'BusyIdle'
  | 'DoNotDisturb'
  | 'Offline'
  | 'OutOfOffice'
  | 'PresenceUnknown'

export type PresenceActivity =
  | 'Available'
  | 'Away'
  | 'BeRightBack'
  | 'Busy'
  | 'DoNotDisturb'
  | 'InACall'
  | 'InAConferenceCall'
  | 'Inactive'
  | 'InAMeeting'
  | 'Offline'
  | 'OffWork'
  | 'OutOfOffice'
  | 'PresenceUnknown'
  | 'Presenting'
  | 'UrgentInterruptionsOnly'
  // Some clients return strings outside the documented enum; tolerate them
  | (string & {})

export type Presence = {
  // For /me/presence Graph returns the user's id; for bulk lookup the id is
  // each requested user id.
  id: string
  availability: PresenceAvailability
  activity: PresenceActivity
}
