// Per-message focus ring.
//
// Within the message pane, focus can land on the message itself or on one of
// its attachments (inline images, then hyperlinks). This module derives the
// ordered list of focusable units for a message and resolves the currently
// focused one from app state, so the key handler, the status bar, and the
// image modal all agree on ordering and identity.
//
// Order: [message, ...images, ...links, thread?]. Index 0 is always the
// message body; indices > 0 step through images, links, then the channel
// reply badge when the message has loaded replies.

import { clampCursor } from '../state/selectables'
import { focusKey, type AppState, type Focus } from '../state/store'
import { extractInlineImages, type InlineImageRef } from '../text/inlineImages'
import { extractMessageLinks, type MessageLinkRef } from '../text/links'
import type { ChatMessage } from '../types'
import { messagesForTimelineNavigation } from './renderableMessage'

export type Focusable =
  | { kind: 'message' }
  | { kind: 'image'; ref: InlineImageRef }
  | { kind: 'link'; ref: MessageLinkRef }
  | { kind: 'thread'; count: number }

export function messageFocusables(message: ChatMessage | undefined, replyCount = 0): Focusable[] {
  if (!message) return [{ kind: 'message' }]
  const focusables: Focusable[] = [{ kind: 'message' }]
  for (const ref of extractInlineImages(message)) focusables.push({ kind: 'image', ref })
  for (const ref of extractMessageLinks(message)) focusables.push({ kind: 'link', ref })
  if (replyCount > 0) focusables.push({ kind: 'thread', count: replyCount })
  return focusables
}

// Loaded replies to a channel root. Only the channel timeline shows reply
// badges; chats and the thread view itself have none.
export function channelReplyCount(
  focus: Focus,
  rawMessages: ChatMessage[],
  messageId: string | undefined,
): number {
  if (focus.kind !== 'channel' || !messageId) return 0
  let n = 0
  for (const m of rawMessages) if (m.replyToId === messageId) n++
  return n
}

// Replies to the message under the cursor, for the focused conversation.
export function focusedReplyCount(state: AppState): number {
  const conv = focusKey(state.focus)
  if (!conv) return 0
  return channelReplyCount(
    state.focus,
    state.messagesByConvo[conv] ?? [],
    focusedNavigationMessage(state)?.id,
  )
}

// The message currently under the pane cursor (mirrors App.tsx's derivation).
export function focusedNavigationMessage(state: AppState): ChatMessage | undefined {
  const conv = focusKey(state.focus)
  if (!conv) return undefined
  const nav = messagesForTimelineNavigation(state.messagesByConvo[conv] ?? [], state.focus)
  if (nav.length === 0) return undefined
  const cursor = clampCursor(state.messageCursorByConvo[conv] ?? nav.length - 1, nav.length)
  return nav[cursor]
}

// The focusable the user has currently selected, or null when focus is on the
// message body (index 0) or the index is out of range.
export function selectFocusedAttachment(state: AppState): Focusable | null {
  if (state.focus.kind === 'list') return null
  const idx = state.focusedAttachmentIndex
  if (!idx || idx <= 0) return null
  const focusables = messageFocusables(focusedNavigationMessage(state), focusedReplyCount(state))
  const focusable = focusables[idx]
  return focusable && focusable.kind !== 'message' ? focusable : null
}
