// Bottom strip: multi-line composer with optimistic send, cursor motion,
// and per-conversation draft persistence.
//
// Active when AppState.inputZone === 'composer'. While active, this
// component captures keystrokes via useInput; the App's global handler
// has its useInput gated to only fire when inputZone === 'list'.
//
// State model:
//   - The buffer + cursor live in the local React state (managed via the
//     reducer in ./composerReducer). Drafts are mirrored into the store
//     under draftsByConvo[focusKey] on every keystroke so switching
//     focus or restarting the app does not lose half-typed text.
//   - When focus changes, the buffer is reseeded from the destination's
//     draft (or empty if none).
//
// Send flow (unchanged):
//   1. Generate a `tempId` and append a local optimistic ChatMessage with
//      _sending: true to messagesByConvo[focus]. Clear the buffer.
//   2. Call sendMessage / sendChannelMessage based on focus.kind.
//   3. On success: replace the optimistic msg (matched by _tempId) with
//      the server response, which has the canonical id.
//   4. On failure: mark the optimistic msg with _sendError, restore the
//      buffer text so the user can edit + retry, and stay in the composer.
//
// Cursor + motion:
//   See composerReducer for the full action list. Bindings: Left, Right,
//   Home/Ctrl+A, End/Ctrl+E, Ctrl+W (delete word), Ctrl+U (delete to
//   line start), Ctrl+K (delete to line end / join), Alt+Backspace
//   (delete word). Ctrl+J inserts a newline; plain Enter sends.
//
// Bracketed paste:
//   On activate the component writes CSI ?2004h to stdout to enable
//   bracketed paste mode; on deactivate it writes CSI ?2004l. Pastes
//   arriving inside the brackets are parsed by ./bracketedPaste and
//   appended verbatim (newlines preserved) instead of being treated
//   as a sequence of individual key events.

import { Box, Text, useInput, useStdin, useStdout } from 'ink'
import { useEffect, useRef, useState } from 'react'
import { sendMessage } from '../graph/chats'
import { postChannelReply, sendChannelMessage } from '../graph/teams'
import { focusKey } from '../state/store'
import type { ChatMessage } from '../types'
import {
  DISABLE_BRACKETED_PASTE,
  ENABLE_BRACKETED_PASTE,
  feed,
  initialParserState,
  type ParserState,
} from './bracketedPaste'
import {
  cursorLineCol,
  emptyBuffer,
  reduce,
  splitLines,
  type ComposerAction,
  type ComposerBuffer,
} from './composerReducer'
import { useAppState, useAppStore, useTheme } from './StoreContext'

const MAX_VISIBLE_LINES = 5

function makeTempId(): string {
  return `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function Composer() {
  const store = useAppStore()
  const { isRawModeSupported } = useStdin()
  const { stdout } = useStdout()
  const focus = useAppState((s) => s.focus)
  const inputZone = useAppState((s) => s.inputZone)
  const drafts = useAppState((s) => s.draftsByConvo)
  const theme = useTheme()
  const [buf, setBuf] = useState<ComposerBuffer>(emptyBuffer)
  const [sending, setSending] = useState(false)
  const parserRef = useRef<ParserState>(initialParserState)

  const conv = focusKey(focus)

  const composerActive =
    isRawModeSupported &&
    inputZone === 'composer' &&
    (focus.kind === 'chat' || focus.kind === 'channel' || focus.kind === 'thread')

  // Re-seed the buffer from the per-conversation draft when focus changes.
  // Tracked by `conv` (a string), so equality comparison is cheap.
  const lastConvRef = useRef<string | null>(conv)
  useEffect(() => {
    if (conv === lastConvRef.current) return
    lastConvRef.current = conv
    const draft = conv ? (drafts[conv] ?? '') : ''
    setBuf({ text: draft, cursor: draft.length })
  }, [conv, drafts])

  // Toggle bracketed paste mode while the composer has focus.
  useEffect(() => {
    if (!composerActive || !stdout) return
    stdout.write(ENABLE_BRACKETED_PASTE)
    return () => {
      stdout.write(DISABLE_BRACKETED_PASTE)
    }
  }, [composerActive, stdout])

  // Persist drafts on every buffer change. Synchronous so a focus
  // switch immediately after typing doesn't drop the last keystroke.
  useEffect(() => {
    if (!conv) return
    if ((drafts[conv] ?? '') === buf.text) return
    store.set((s) => {
      const next = { ...s.draftsByConvo }
      if (buf.text === '') {
        delete next[conv]
      } else {
        next[conv] = buf.text
      }
      return { draftsByConvo: next }
    })
    // We intentionally only depend on buf.text + conv: drafts is just a
    // read-side mirror and changing it would re-trigger this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buf.text, conv])

  function dispatch(action: ComposerAction): void {
    setBuf((b) => reduce(b, action))
  }

  useInput(
    (input, key) => {
      // Bracketed paste handling first: if input contains the start
      // bracket, run it through the parser and dispatch typed events.
      if (input.includes('\x1b[200~') || parserRef.current.inPaste) {
        const r = feed(parserRef.current, input)
        parserRef.current = r.state
        for (const ev of r.events) {
          if (ev.kind === 'paste') dispatch({ kind: 'insert', chars: ev.chars })
          else dispatch({ kind: 'insert', chars: ev.chars })
        }
        return
      }

      if (key.escape) {
        store.set({ inputZone: 'list' })
        return
      }
      // Ctrl+J inserts a newline; plain Enter sends.
      if (key.ctrl && input === 'j') {
        dispatch({ kind: 'newline' })
        return
      }
      if (key.return) {
        void doSend(buf.text)
        return
      }
      // Cursor motion
      if (key.leftArrow) return dispatch({ kind: 'cursor-left' })
      if (key.rightArrow) return dispatch({ kind: 'cursor-right' })
      if (key.upArrow) return // up/down across visual lines: not yet
      if (key.downArrow) return
      if (key.ctrl && input === 'a') return dispatch({ kind: 'cursor-line-start' })
      if (key.ctrl && input === 'e') return dispatch({ kind: 'cursor-line-end' })
      if (key.meta && key.leftArrow) return dispatch({ kind: 'cursor-prev-word' })
      if (key.meta && key.rightArrow) return dispatch({ kind: 'cursor-next-word' })

      // Deletion
      if (key.backspace || key.delete) {
        if (key.meta) return dispatch({ kind: 'delete-prev-word' })
        return dispatch({ kind: 'backspace' })
      }
      if (key.ctrl && input === 'w') return dispatch({ kind: 'delete-prev-word' })
      if (key.ctrl && input === 'u') return dispatch({ kind: 'delete-to-line-start' })
      if (key.ctrl && input === 'k') return dispatch({ kind: 'delete-to-line-end' })

      // Filter out remaining control / meta combos; insert plain typed
      // characters (Ink supplies most multi-character pastes as a single
      // input string when bracketed paste mode isn't supported).
      if (input && !key.ctrl && !key.meta) {
        dispatch({ kind: 'insert', chars: input })
      }
    },
    { isActive: composerActive },
  )

  async function doSend(content: string): Promise<void> {
    const trimmed = content.trim()
    if (!trimmed) return
    if (focus.kind !== 'chat' && focus.kind !== 'channel' && focus.kind !== 'thread') return
    if (sending) return

    const convForSend = focusKey(focus)
    if (!convForSend) return

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
    setBuf(emptyBuffer)
    store.set((s) => {
      const nextDrafts = { ...s.draftsByConvo }
      delete nextDrafts[convForSend]
      return {
        messagesByConvo: {
          ...s.messagesByConvo,
          [convForSend]: [...(s.messagesByConvo[convForSend] ?? []), optimistic],
        },
        draftsByConvo: nextDrafts,
      }
    })

    try {
      const sent =
        focus.kind === 'chat'
          ? await sendMessage(focus.chatId, trimmed)
          : focus.kind === 'channel'
            ? await sendChannelMessage(focus.teamId, focus.channelId, trimmed)
            : await postChannelReply(focus.teamId, focus.channelId, focus.rootId, trimmed)
      store.set((s) => ({
        messagesByConvo: {
          ...s.messagesByConvo,
          [convForSend]: (s.messagesByConvo[convForSend] ?? []).map((m) =>
            m._tempId === tempId ? sent : m,
          ),
        },
      }))
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'send failed'
      // Restore the buffer so the user can edit + retry.
      setBuf({ text: trimmed, cursor: trimmed.length })
      store.set((s) => ({
        messagesByConvo: {
          ...s.messagesByConvo,
          [convForSend]: (s.messagesByConvo[convForSend] ?? []).map((m) =>
            m._tempId === tempId ? { ...m, _sending: false, _sendError: errorMessage } : m,
          ),
        },
        draftsByConvo: { ...s.draftsByConvo, [convForSend]: trimmed },
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

  // --- Render ---
  const lines = splitLines(buf.text)
  const { line: cursorLine, col: cursorCol } = cursorLineCol(buf.text, buf.cursor)
  // Show up to MAX_VISIBLE_LINES around the cursor; bias toward the
  // last lines so a long buffer stays anchored to the most recent
  // content while typing.
  const totalLines = lines.length
  const overflow = Math.max(0, totalLines - MAX_VISIBLE_LINES)
  let firstVisible = Math.max(0, totalLines - MAX_VISIBLE_LINES)
  // If the cursor is inside the hidden head, scroll up so it's visible.
  if (cursorLine < firstVisible) firstVisible = cursorLine
  const visible = lines.slice(firstVisible, firstVisible + MAX_VISIBLE_LINES)

  return (
    <Box paddingX={1} flexDirection="column">
      {overflow > 0 && firstVisible > 0 && (
        <Box>
          <Text color={theme.mutedText}>… {firstVisible} earlier line(s)</Text>
        </Box>
      )}
      {visible.map((line, i) => {
        const lineIdx = i + firstVisible
        const isCursorLine = composerActive && lineIdx === cursorLine
        const prefix = lineIdx === 0 ? (composerActive ? '> ' : '  ') : '  '
        if (!isCursorLine) {
          return (
            <Box key={lineIdx}>
              <Text color={composerActive ? undefined : theme.infoText}>
                {prefix}
                {line}
              </Text>
            </Box>
          )
        }
        const before = line.slice(0, cursorCol)
        const after = line.slice(cursorCol)
        return (
          <Box key={lineIdx}>
            <Text>
              {prefix}
              {before}
              <Text color="cyan">█</Text>
              {after}
            </Text>
          </Box>
        )
      })}
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
