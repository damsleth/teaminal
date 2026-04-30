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

export type ChatMessage = {
  id: string
  createdDateTime: string
  lastModifiedDateTime?: string
  chatId?: string
  messageType?: 'message' | 'systemEventMessage' | 'unknownFutureValue' | string
  from?: IdentitySet
  body: MessageBody
  mentions?: Mention[]
  importance?: 'normal' | 'high' | 'urgent'
  attachments?: unknown[]
  reactions?: unknown[]
  replyToId?: string | null
  subject?: string | null
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
