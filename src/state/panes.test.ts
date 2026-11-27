import { describe, expect, test } from 'bun:test'
import {
  activeSide,
  closeOtherPane,
  openInOtherPane,
  otherFocus,
  paneFocus,
  sendToOtherPane,
  switchPane,
  visibleConvKeys,
} from './panes'
import { createAppStore, focusKey, type AppState, type Focus } from './store'

const A: Focus = { kind: 'chat', chatId: 'chat-a' }
const B: Focus = { kind: 'chat', chatId: 'design' }
const LIST: Focus = { kind: 'list' }
const THREAD: Focus = { kind: 'thread', teamId: 't1', channelId: 'c1', rootId: 'r1' }

function state(over: Partial<AppState> = {}): AppState {
  return { ...createAppStore().get(), ...over }
}

// Apply a patch builder, as `store.set((s) => builder(s))` does.
function apply(s: AppState, patch: Partial<AppState>): AppState {
  return { ...s, ...patch }
}

const keys = (s: AppState) => ({
  left: focusKey(paneFocus(s, 'left')),
  right: focusKey(paneFocus(s, 'right')),
})

describe('paneFocus', () => {
  test('without a split: left is the active pane, right is empty', () => {
    const s = state({ focus: A })
    expect(paneFocus(s, 'left')).toBe(s.focus)
    expect(paneFocus(s, 'right')).toEqual(LIST)
    expect(activeSide(s)).toBe('left')
  })

  test('with a split, for both sides of the passive pane', () => {
    const right = state({ focus: A, split: { focus: B, side: 'right' } })
    expect(keys(right)).toEqual({ left: 'chat:chat-a', right: 'chat:design' })
    expect(activeSide(right)).toBe('left')
    const left = state({ focus: A, split: { focus: B, side: 'left' } })
    expect(keys(left)).toEqual({ left: 'chat:design', right: 'chat:chat-a' })
    expect(activeSide(left)).toBe('right')
  })

  test('an empty active pane: its side is empty, the other conversation stays', () => {
    const s = state({ focus: LIST, split: { focus: A, side: 'right' } })
    expect(keys(s)).toEqual({ left: null, right: 'chat:chat-a' })
  })

  test('a duplicate is hidden, not removed, and shows again once focus moves off it', () => {
    const s = state({ focus: A, split: { focus: A, side: 'right' } })
    expect(otherFocus(s)).toBeNull()
    expect(keys(s)).toEqual({ left: 'chat:chat-a', right: null })
    expect(s.split?.focus).toEqual(A)
    const moved = apply(s, { focus: B })
    expect(keys(moved)).toEqual({ left: 'chat:design', right: 'chat:chat-a' })
  })

  test('the duplicate rule holds from either side, without moving the active pane', () => {
    const s = state({ focus: A, split: { focus: A, side: 'left' } })
    expect(keys(s)).toEqual({ left: null, right: 'chat:chat-a' })
  })
})

describe('visibleConvKeys', () => {
  test('the active conversation only, without a split', () => {
    expect(visibleConvKeys(state({ focus: A }))).toEqual(['chat:chat-a'])
    expect(visibleConvKeys(state({ focus: LIST }))).toEqual([])
  })

  test('the passive conversation counts only while it is shown', () => {
    const s = state({ focus: A, split: { focus: THREAD, side: 'right' } })
    expect(visibleConvKeys(s)).toEqual(['chat:chat-a'])
    expect(visibleConvKeys({ ...s, splitShown: true })).toEqual(['chat:chat-a', 'thread:t1:c1:r1'])
  })

  test('includes thread keys for the active pane', () => {
    expect(visibleConvKeys(state({ focus: THREAD }))).toEqual(['thread:t1:c1:r1'])
  })

  test('a hidden duplicate is listed once', () => {
    const s = state({ focus: A, split: { focus: A, side: 'right' }, splitShown: true })
    expect(visibleConvKeys(s)).toEqual(['chat:chat-a'])
  })
})

describe('patch builders', () => {
  test('openInOtherPane creates the split on the right; the list keeps the keys', () => {
    const s = apply(state({ focus: LIST }), openInOtherPane(state({ focus: LIST }), A))
    expect(s.split).toEqual({ focus: A, side: 'right' })
    expect(s.focus).toEqual(LIST)
    expect(s.inputZone).toBe('list')
  })

  test('openInOtherPane replaces the passive conversation and keeps its side', () => {
    const s = state({ focus: LIST, split: { focus: A, side: 'left' } })
    expect(openInOtherPane(s, B)).toEqual({ split: { focus: B, side: 'left' } })
  })

  test('openInOtherPane on the conversation already there is a no-op', () => {
    const s = state({ focus: LIST, split: { focus: A, side: 'right' } })
    expect(openInOtherPane(s, { kind: 'chat', chatId: 'chat-a' })).toEqual({})
    expect(openInOtherPane(s, LIST)).toEqual({})
  })

  test('sendToOtherPane without a split keeps the conversation on its side', () => {
    const s0 = state({ focus: A })
    const s = apply(s0, sendToOtherPane(s0))
    expect(s.split).toEqual({ focus: A, side: 'left' })
    expect(s.focus).toEqual(LIST)
    expect(activeSide(s)).toBe('right')
    // The left loop's target is unchanged: no refetch.
    expect(keys(s)).toEqual({ left: 'chat:chat-a', right: null })
  })

  test('sendToOtherPane with a split replaces the passive conversation', () => {
    const s0 = state({ focus: A, split: { focus: B, side: 'right' } })
    const s = apply(s0, sendToOtherPane(s0))
    expect(s.split).toEqual({ focus: A, side: 'right' })
    expect(s.focus).toEqual(LIST)
    expect(sendToOtherPane(state({ focus: LIST }))).toEqual({})
  })

  test('switchPane swaps, flips side, and clears search, edit and attachment index', () => {
    const s0 = state({
      focus: A,
      split: { focus: B, side: 'right' },
      messageSearchQuery: 'launch',
      messageSearchFocusedId: 'm1',
      editingMessageId: 'm2',
      focusedAttachmentIndex: 2,
    })
    const s = apply(s0, switchPane(s0))
    expect(s.focus).toBe(B)
    expect(s.split).toEqual({ focus: A, side: 'left' })
    expect(s.messageSearchQuery).toBe('')
    expect(s.messageSearchFocusedId).toBeNull()
    expect(s.editingMessageId).toBeNull()
    expect(s.focusedAttachmentIndex).toBe(0)
    // Neither side's target changed.
    expect(keys(s)).toEqual(keys(s0))
    expect(switchPane(state({ focus: A }))).toEqual({})
  })

  test('switchPane from an empty active pane: the empty pane becomes the passive one', () => {
    const s0 = state({ focus: LIST, split: { focus: A, side: 'right' } })
    const s = apply(s0, switchPane(s0))
    expect(s.focus).toBe(A)
    expect(s.split).toEqual({ focus: LIST, side: 'left' })
    expect(keys(s)).toEqual(keys(s0))
  })

  test('switchPane onto a hidden duplicate lands on an empty pane', () => {
    const s0 = state({ focus: A, split: { focus: A, side: 'right' } })
    const s = apply(s0, switchPane(s0))
    expect(s.focus).toEqual(LIST)
    expect(keys(s)).toEqual(keys(s0))
  })

  test('closeOtherPane keeps the active conversation', () => {
    const s0 = state({ focus: A, split: { focus: B, side: 'left' } })
    const s = apply(s0, closeOtherPane(s0))
    expect(s.split).toBeNull()
    expect(s.focus).toBe(A)
    expect(closeOtherPane(state({ focus: A }))).toEqual({})
  })

  test('closeOtherPane with an empty active pane keeps the other conversation, active', () => {
    const s0 = state({ focus: LIST, split: { focus: A, side: 'right' } })
    const s = apply(s0, closeOtherPane(s0))
    expect(s.split).toBeNull()
    expect(s.focus).toBe(A)
    expect(keys(s)).toEqual({ left: 'chat:chat-a', right: null })
  })

  test('closeOtherPane with both panes empty just closes', () => {
    const s0 = state({ focus: LIST, split: { focus: LIST, side: 'right' } })
    expect(closeOtherPane(s0)).toEqual({ split: null })
  })
})
