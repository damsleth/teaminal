// Keep the per-conversation message cursor in bounds when the message
// list grows, shrinks, or the user changes focus.
//
// New conversations get the cursor placed at the newest message. After
// that, the cursor sticks unless it's beyond the new length, or a new
// message lands at the bottom and settings.scrollOnNewMessages is on.

import { useEffect, useRef } from 'react'
import { clampCursor } from '../../state/selectables'
import { focusKey, type AppState, type Focus, type Store } from '../../state/store'
import { messagesForTimelineNavigation } from '../renderableMessage'

export function useClampMessageCursor(
  focus: Focus,
  messagesByConvo: AppState['messagesByConvo'],
  store: Store<AppState>,
): void {
  // Newest navigable message id per conversation, to tell a new arrival
  // apart from loading older pages (which only prepend).
  const newestByConv = useRef(new Map<string, string>())
  useEffect(() => {
    const conv = focusKey(focus)
    if (!conv) return
    // Clamp against the NAVIGABLE list (roots-only for channels), matching
    // the cursor index space the message pane actually renders.
    const nav = messagesForTimelineNavigation(messagesByConvo[conv] ?? [], focus)
    const count = nav.length
    if (count === 0) return
    const newest = nav[count - 1]!.id
    const prevNewest = newestByConv.current.get(conv)
    newestByConv.current.set(conv, newest)
    const arrived = prevNewest !== undefined && prevNewest !== newest
    store.set((s) => {
      const existing = s.messageCursorByConvo[conv]
      const next =
        existing === undefined || (arrived && s.settings.scrollOnNewMessages)
          ? count - 1
          : clampCursor(existing, count)
      if (existing === next) return {}
      return {
        messageCursorByConvo: {
          ...s.messageCursorByConvo,
          [conv]: next,
        },
      }
    })
  }, [focus, messagesByConvo, store])
}
