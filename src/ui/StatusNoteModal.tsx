// Set or clear the status message. Two fields: the text and an optional end
// time (see parseStatusEnd for the accepted forms).
//
//   Tab / ↑ / ↓  switch field      Enter  save
//   Ctrl+X       clear the status  Esc    cancel

import { Box, useApp } from 'ink'
import { useState } from 'react'
import { Text } from './Text'
import { inkBorder, modalBg } from './theme'
import { useInput } from './useInput'
import { accountStore } from '../state/accountStore'
import { parseStatusEnd, setStatusNote } from '../state/presenceActions'
import { useAppState, useAppStore, useTheme } from './StoreContext'

const WIDTH = 56

export function StatusNoteModal() {
  const { exit } = useApp()
  const store = useAppStore()
  const modal = useAppState((s) => s.modal)
  const theme = useTheme()
  const isOpen = modal?.kind === 'status-note'

  const [message, setMessage] = useState(() => store.get().myPresence?.note?.message ?? '')
  const [ends, setEnds] = useState('')
  const [field, setField] = useState<'message' | 'ends'>('message')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = () => store.set({ modal: null, inputZone: 'list' })
  const submit = (text: string, expiry: Date | null) => {
    setBusy(true)
    setError(null)
    setStatusNote(accountStore(store), text, expiry)
      .then(close)
      .catch((err) => {
        setBusy(false)
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  useInput(
    (input, key) => {
      if (!isOpen || busy) return
      const ch = input.toLowerCase()
      if (key.ctrl && ch === 'c') return exit()
      if (key.escape) return close()
      if (key.ctrl && ch === 'x') return submit('', null)
      if (key.tab || key.upArrow || key.downArrow) {
        setField((f) => (f === 'message' ? 'ends' : 'message'))
        return
      }
      if (key.return) {
        if (!message.trim()) return setError('Type a message, or Ctrl+X to clear the status')
        const expiry = parseStatusEnd(ends)
        if (expiry === null)
          return setError('Ends: try 30m, 2h, today, tomorrow, 15:30, 2026-11-02')
        return submit(message, expiry ?? null)
      }
      const set = field === 'message' ? setMessage : setEnds
      if (key.backspace || key.delete) return set((v) => v.slice(0, -1))
      if (input && !key.ctrl && !key.meta) set((v) => v + input)
    },
    { isActive: isOpen },
  )

  if (!isOpen) return null
  const bg = modalBg(theme)
  const row = (label: string, value: string, active: boolean) => (
    <Text color={active ? theme.selected : theme.text} backgroundColor={bg} wrap="truncate-end">
      {`${active ? '> ' : '  '}${label.padEnd(9)}${value}${active ? '▏' : ''}`.padEnd(WIDTH)}
    </Text>
  )

  return (
    <Box
      flexDirection="column"
      borderStyle={inkBorder(theme.borders.modal)}
      borderColor={theme.borderActive}
      backgroundColor={bg}
      paddingX={theme.layout.modalPaddingX}
      paddingY={theme.layout.modalPaddingY}
    >
      <Text bold={theme.emphasis.modalTitleBold} backgroundColor={bg}>
        {'Status message'.padEnd(WIDTH)}
      </Text>
      <Text backgroundColor={bg}>{''.padEnd(WIDTH)}</Text>
      {row('Message', message, field === 'message')}
      {row('Ends', ends, field === 'ends')}
      <Text muted backgroundColor={bg}>
        {'  (blank = never; 30m, 2h, today, tomorrow, 15:30, 2026-11-02)'.padEnd(WIDTH)}
      </Text>
      <Text backgroundColor={bg}>{''.padEnd(WIDTH)}</Text>
      <Text color={error ? 'red' : undefined} muted={!error} backgroundColor={bg}>
        {(busy ? 'Saving…' : (error ?? 'tab field · enter save · ^X clear · esc cancel')).padEnd(
          WIDTH,
        )}
      </Text>
    </Box>
  )
}
