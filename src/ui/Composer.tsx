// Bottom strip: multi-line input with optimistic send.
//
// Active when AppState.inputZone === 'composer'. While active, this
// component captures keystrokes via useInput; the App's global handler
// has its useInput gated to only fire when inputZone === 'list'.
//
// Send flow:
//   1. Generate a `tempId` and append a local optimistic ChatMessage with
//      _sending: true to messagesByConvo[focus]. Clear the buffer.
//   2. Call sendMessage / sendChannelMessage based on focus.kind.
//   3. On success: replace the optimistic msg (matched by _tempId) with
//      the server response, which has the canonical id.
//   4. On failure: mark the optimistic msg with _sendError, restore the
//      buffer text so the user can edit + retry, and stay in the composer.
//
// The poller's active-loop merge in mergeWithOptimistic preserves
// _sending and _sendError optimistic msgs across server fetches that
// might land mid-send.

import { Box, Text, useInput, useStdin } from 'ink'
import { useState } from 'react'
import { sendMessage } from '../graph/chats'
import { sendChannelMessage } from '../graph/teams'
import { focusKey } from '../state/store'
import type { ChatMessage } from '../types'
import { useAppState, useAppStore } from './StoreContext'
import { theme } from './theme'

function makeTempId(): string {
  return `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function Composer() {
  const store = useAppStore()
  const { isRawModeSupported } = useStdin()
  const focus = useAppState((s) => s.focus)
  const inputZone = useAppState((s) => s.inputZone)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)

  const composerActive =
    isRawModeSupported &&
    inputZone === 'composer' &&
    (focus.kind === 'chat' || focus.kind === 'channel')

  useInput(
    (input, key) => {
      if (key.escape) {
        store.set({ inputZone: 'list' })
        return
      }
      // Ctrl+J inserts a newline; plain Enter sends.
      if (key.ctrl && input === 'j') {
        setText((t) => t + '\n')
        return
      }
      if (key.return) {
        void doSend(text)
        return
      }
      if (key.backspace || key.delete) {
        setText((t) => t.slice(0, -1))
        return
      }
      // Filter out control sequences and meta combos; leave plain typed
      // characters (Ink supplies multi-character pastes as a single input).
      if (input && !key.ctrl && !key.meta) {
        setText((t) => t + input)
      }
    },
    { isActive: composerActive },
  )

  async function doSend(content: string): Promise<void> {
    const trimmed = content.trim()
    if (!trimmed) return
    if (focus.kind !== 'chat' && focus.kind !== 'channel') return
    if (sending) return

    const conv = focusKey(focus)
    if (!conv) return

    const tempId = makeTempId()
    const myId = store.get().me?.id
    const myName = store.get().me?.displayName ?? 'Me'
    const optimistic: ChatMessage = {
      id: tempId,
      _tempId: tempId,
      _sending: true,
      createdDateTime: new Date().toISOString(),
      body: { contentType: 'text', content: trimmed },
      from: myId
        ? { user: { id: myId, displayName: myName } }
        : { user: { id: 'me', displayName: myName } },
    }

    setSending(true)
    setText('')
    store.set((s) => ({
      messagesByConvo: {
        ...s.messagesByConvo,
        [conv]: [...(s.messagesByConvo[conv] ?? []), optimistic],
      },
    }))

    try {
      const sent =
        focus.kind === 'chat'
          ? await sendMessage(focus.chatId, trimmed)
          : await sendChannelMessage(focus.teamId, focus.channelId, trimmed)
      store.set((s) => ({
        messagesByConvo: {
          ...s.messagesByConvo,
          [conv]: (s.messagesByConvo[conv] ?? []).map((m) =>
            m._tempId === tempId ? sent : m,
          ),
        },
      }))
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'send failed'
      // Restore the buffer so the user can edit + retry.
      setText(trimmed)
      store.set((s) => ({
        messagesByConvo: {
          ...s.messagesByConvo,
          [conv]: (s.messagesByConvo[conv] ?? []).map((m) =>
            m._tempId === tempId
              ? { ...m, _sending: false, _sendError: errorMessage }
              : m,
          ),
        },
      }))
    } finally {
      setSending(false)
    }
  }

  if (focus.kind === 'list') {
    return (
      <Box paddingX={1}>
        <Text color="gray">open a chat to compose</Text>
      </Box>
    )
  }

  // Render: prompt, current buffer, status hint. Newlines collapse to a
  // single space in this minimal v1 view (the buffer is preserved verbatim
  // for sending; the visual width budget is one row).
  const display = text.replace(/\n/g, '↵').slice(-160)
  const cursor = composerActive ? '█' : ''

  return (
    <Box paddingX={1} flexDirection="column">
      <Box>
        <Text color={composerActive ? undefined : theme.infoText}>
          {composerActive ? '> ' : '  '}
          {display}
          {cursor}
        </Text>
      </Box>
      {!composerActive && (
        <Box>
          <Text color="gray">Tab to compose · Esc to leave</Text>
        </Box>
      )}
      {sending && (
        <Box>
          <Text color="gray">sending...</Text>
        </Box>
      )}
    </Box>
  )
}
