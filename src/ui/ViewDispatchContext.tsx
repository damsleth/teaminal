// Side-effect dispatcher. In host mode, calls into local code (chatsvc,
// poller). In view mode, sends an RPC to the host. Lets UI components
// stay zone-agnostic and not branch on "am I a view?".
//
// Pure-state mutations don't go through this — they ride the store,
// and ViewStore intercepts `set()` to ship them to the host as
// setState. This context is only for things that need the network /
// poller / chatsvc access.

import { createContext, useContext, type ReactNode } from 'react'
import type { Focus } from '../state/store'
import type { ViewHandle } from '../ipc/view'
import { postChannelReply, sendChannelMessage, sendChatMessage } from '../state/chatActions'
import type { PollerHandleRef } from '../state/poller'

export type ViewDispatch = {
  refresh(): void
  hardRefresh(): void
  submitMessage(focus: Focus, text: string): Promise<void>
}

const ViewDispatchContext = createContext<ViewDispatch | null>(null)

export function useViewDispatch(): ViewDispatch {
  const v = useContext(ViewDispatchContext)
  if (!v) throw new Error('useViewDispatch called outside ViewDispatchProvider')
  return v
}

export function ViewDispatchProvider({
  value,
  children,
}: {
  value: ViewDispatch
  children: ReactNode
}) {
  return <ViewDispatchContext.Provider value={value}>{children}</ViewDispatchContext.Provider>
}

// Build a host-mode dispatcher backed by local calls. Used when this
// process owns the poller + chatsvc tokens.
export function makeHostDispatch(pollerRef: PollerHandleRef): ViewDispatch {
  return {
    refresh: () => pollerRef.current?.refresh(),
    hardRefresh: () => pollerRef.current?.hardRefresh?.(),
    async submitMessage(focus: Focus, text: string) {
      if (focus.kind === 'chat') {
        await sendChatMessage(focus.chatId, text)
      } else if (focus.kind === 'channel') {
        await sendChannelMessage(focus.teamId, focus.channelId, text)
      } else if (focus.kind === 'thread') {
        await postChannelReply(focus.teamId, focus.channelId, focus.rootId, text)
      } else {
        throw new Error('submitMessage requires a chat / channel / thread focus')
      }
      pollerRef.current?.refresh()
    },
  }
}

// Build a view-mode dispatcher backed by an IPC ViewHandle. Sends RPCs
// to the host and resolves when the host has accepted them.
export function makeViewDispatch(view: ViewHandle): ViewDispatch {
  return {
    refresh: () => view.dispatch('refresh', {}),
    hardRefresh: () => view.dispatch('hardRefresh', {}),
    async submitMessage(focus: Focus, text: string) {
      if (focus.kind === 'chat') {
        view.dispatch('submitMessage', { kind: 'chat', chatId: focus.chatId, text })
      } else if (focus.kind === 'channel') {
        view.dispatch('submitMessage', {
          kind: 'channel',
          teamId: focus.teamId,
          channelId: focus.channelId,
          text,
        })
      } else if (focus.kind === 'thread') {
        view.dispatch('submitMessage', {
          kind: 'reply',
          teamId: focus.teamId,
          channelId: focus.channelId,
          rootId: focus.rootId,
          text,
        })
      } else {
        throw new Error('submitMessage requires a chat / channel / thread focus')
      }
    },
  }
}
