// Per-message focus ring.
//
// Within the message pane, focus can land on the message itself or on one of
// its attachments (inline images, then hyperlinks). This module derives the
// ordered list of focusable units for a message and resolves the currently
// focused one from app state, so the key handler, the status bar, and the
// image modal all agree on ordering and identity.
//
// Order: [message, ...images, ...links]. Index 0 is always the message body;
// indices > 0 step through images then links.

import { clampCursor } from '../state/selectables'
import { focusKey, type AppState } from '../state/store'
import { extractInlineImages, type InlineImageRef } from '../text/inlineImages'
import { extractMessageLinks, type MessageLinkRef } from '../text/links'
import type { ChatMessage } from '../types'
import { messagesForTimelineNavigation } from './renderableMessage'

export type Focusable =
  | { kind: 'message' }
  | { kind: 'image'; ref: InlineImageRef }
  | { kind: 'link'; ref: MessageLinkRef }

export function messageFocusables(message: ChatMessage | undefined): Focusable[] {
  if (!message) return [{ kind: 'message' }]
  const focusables: Focusable[] = [{ kind: 'message' }]
  for (const ref of extractInlineImages(message)) focusables.push({ kind: 'image', ref })
  for (const ref of extractMessageLinks(message)) focusables.push({ kind: 'link', ref })
  return focusables
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
  const focusables = messageFocusables(focusedNavigationMessage(state))
  const focusable = focusables[idx]
  return focusable && focusable.kind !== 'message' ? focusable : null
}
