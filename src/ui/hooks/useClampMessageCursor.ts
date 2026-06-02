// Keep the per-conversation message cursor in bounds when the message
// list grows, shrinks, or the user changes focus.
//
// New conversations get the cursor placed at the newest message. After
// that, the cursor sticks unless it's beyond the new length.

import { useEffect } from 'react'
import { clampCursor } from '../../state/selectables'
import { focusKey, type AppState, type Focus, type Store } from '../../state/store'
import { messagesForTimelineNavigation } from '../renderableMessage'

export function useClampMessageCursor(
  focus: Focus,
  messagesByConvo: AppState['messagesByConvo'],
  store: Store<AppState>,
): void {
  useEffect(() => {
    const conv = focusKey(focus)
    if (!conv) return
    // Clamp against the NAVIGABLE list (roots-only for channels), matching
    // the cursor index space the message pane actually renders.
    const count = messagesForTimelineNavigation(messagesByConvo[conv] ?? [], focus).length
    if (count === 0) return
    store.set((s) => {
      const existing = s.messageCursorByConvo[conv]
      const next = existing === undefined ? count - 1 : clampCursor(existing, count)
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
