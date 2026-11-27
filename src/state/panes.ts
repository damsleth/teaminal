// Split panes: two conversations of the foreground account side by side.
//
// `focus` stays the active pane (keys, cursor, composer). `split` holds the
// passive pane's conversation and its side; the active pane sits on the
// other side. Switching panes swaps the two and flips `side`, so neither
// conversation moves on screen and neither side's poll loop changes target.
//
// The same conversation is never in both panes: when split.focus names the
// active conversation, the passive pane renders empty and its loop idles,
// but split.focus keeps its value, so it shows again once the active pane
// moves off it. That covers every focus writer (palette, Activity, search,
// new chat) without changing them.
//
// Poll targets (paneFocus) and viewed conversations (visibleConvKeys) differ:
// a passive pane that is not on screen (App publishes splitShown) still
// polls but is not viewed, so it is not marked read and notifies normally.
//
// The patch builders return global UI fields for the raw Store (AGENTS.md
// rule 4): `store.set((s) => switchPane(s))`.

import { focusKey, type AppState, type ConvKey, type Focus } from './store'

export type PaneSide = 'left' | 'right'

const LIST: Focus = Object.freeze({ kind: 'list' })

type PaneState = Pick<AppState, 'focus' | 'split' | 'splitShown'>

function opposite(side: PaneSide): PaneSide {
  return side === 'left' ? 'right' : 'left'
}

// The side the active pane (`focus`) is on: left without a split.
export function activeSide(s: Pick<AppState, 'split'>): PaneSide {
  return s.split ? opposite(s.split.side) : 'left'
}

// The passive pane's conversation, or null when there is no split, the
// passive pane is empty, or it names the active conversation (hidden).
export function otherFocus(s: Pick<AppState, 'focus' | 'split'>): Focus | null {
  if (!s.split) return null
  const key = focusKey(s.split.focus)
  if (!key || key === focusKey(s.focus)) return null
  return s.split.focus
}

// What the pane on `side` shows and polls. Without a split: left is the
// active pane, right is empty.
export function paneFocus(s: Pick<AppState, 'focus' | 'split'>, side: PaneSide): Focus {
  if (!s.split) return side === 'left' ? s.focus : LIST
  if (side === s.split.side) return otherFocus(s) ?? LIST
  return s.focus
}

// The conversations the user is looking at: the active one, and the passive
// one while it is on screen.
export function visibleConvKeys(s: PaneState): ConvKey[] {
  const keys: ConvKey[] = []
  const active = focusKey(s.focus)
  if (active) keys.push(active)
  const other = s.splitShown ? otherFocus(s) : null
  const otherKey = other ? focusKey(other) : null
  if (otherKey) keys.push(otherKey)
  return keys
}

// Leaving a conversation in the active pane drops its transient state, as a
// focus change does.
const CLEAR_TRANSIENT = {
  messageSearchQuery: '',
  messageSearchFocusedId: null,
  editingMessageId: null,
  focusedAttachmentIndex: 0,
} as const satisfies Partial<AppState>

// `v` on a list row: open `target` in the passive pane, creating the split
// with the passive pane on the right. No-op when it is already there.
export function openInOtherPane(s: PaneState, target: Focus): Partial<AppState> {
  const key = focusKey(target)
  if (!key) return {}
  if (!s.split) return { split: { focus: target, side: 'right' } }
  if (focusKey(s.split.focus) === key) return {}
  return { split: { focus: target, side: s.split.side } }
}

// `v` in a conversation: send it to the passive pane and empty the active
// pane. Without a split the conversation stays on its side and the empty
// active pane opens on the right; with one it replaces the passive pane's
// conversation.
export function sendToOtherPane(s: PaneState): Partial<AppState> {
  if (!focusKey(s.focus)) return {}
  return {
    split: { focus: s.focus, side: s.split ? s.split.side : 'left' },
    focus: LIST,
    inputZone: 'list',
    ...CLEAR_TRANSIENT,
  }
}

// `w`: the passive pane becomes the active one. Sides stay, so nothing
// moves or refetches. A hidden duplicate counts as an empty pane.
export function switchPane(s: PaneState): Partial<AppState> {
  if (!s.split) return {}
  return {
    focus: otherFocus(s) ?? LIST,
    split: { focus: s.focus, side: opposite(s.split.side) },
    ...CLEAR_TRANSIENT,
  }
}

// `o`: keep one pane. The active one when it has a conversation; else the
// passive pane's conversation becomes the single, active pane.
export function closeOtherPane(s: PaneState): Partial<AppState> {
  if (!s.split) return {}
  if (focusKey(s.focus)) return { split: null }
  const other = otherFocus(s)
  return other ? { split: null, focus: other, ...CLEAR_TRANSIENT } : { split: null }
}
