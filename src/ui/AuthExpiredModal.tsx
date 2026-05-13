// Auth-expired prompt.
//
// Shown when bootstrap (or a session restart) fails because the
// owa-piggy refresh token has hit its hard expiry (e.g. the SPA 24h
// cap, AADSTS700084). Bootstrapping is dead until the user does one
// of: reseed the profile in place, switch to a different profile, or
// quit. We prefer to render this rather than crash so the running
// teaminal process can recover without the user having to start the
// CLI over.

import { Box, Text, useApp, useInput } from 'ink'
import { reseed } from '../auth/owaPiggy'
import { useSessionApi } from './SessionContext'
import { useAppState, useAppStore, useTheme } from './StoreContext'

export function AuthExpiredModal() {
  const { exit } = useApp()
  const store = useAppStore()
  const session = useSessionApi()
  const modal = useAppState((s) => s.modal)
  const theme = useTheme()
  const isOpen = modal?.kind === 'auth-expired'

  useInput(
    (input, key) => {
      if (!isOpen) return
      if (modal.status !== 'idle') return
      const ch = input.toLowerCase()
      if (key.ctrl && ch === 'c') {
        exit()
        return
      }
      if (ch === 'q') {
        exit()
        return
      }
      if (ch === 's') {
        store.set({
          modal: { kind: 'accounts', mode: 'list', cursor: 0, accounts: [] },
        })
        return
      }
      if (ch === 'r') {
        void runReseed()
      }
    },
    { isActive: isOpen },
  )

  async function runReseed(): Promise<void> {
    if (!isOpen) return
    const profile = modal.profile
    store.set({
      modal: { ...modal, status: 'reseeding', lastError: undefined },
    })
    try {
      await reseed(profile ? { profile } : undefined)
    } catch (err) {
      store.set({
        modal: {
          ...modal,
          status: 'idle',
          lastError: err instanceof Error ? err.message : String(err),
        },
      })
      return
    }
    store.set({ modal: { ...modal, status: 'retrying', lastError: undefined } })
    try {
      await session.switchAccount(profile)
      // Bootstrap succeeded: drop the modal entirely.
      store.set({ modal: null, inputZone: 'list' })
    } catch (err) {
      store.set({
        modal: {
          ...modal,
          status: 'idle',
          lastError: err instanceof Error ? err.message : String(err),
        },
      })
    }
  }

  if (!isOpen) return null

  const label = modal.profile ?? '(default)'
  return (
    <Box alignItems="center" justifyContent="center" flexGrow={1}>
      <Box
        flexDirection="column"
        borderStyle={theme.borders.modal}
        borderColor={theme.borderActive}
        paddingX={theme.layout.modalPaddingX}
        paddingY={theme.layout.modalPaddingY}
      >
        <Text bold={theme.emphasis.modalTitleBold} color={theme.errorText}>
          Authentication expired
        </Text>
        <Box height={1} />
        <Text>
          {'Profile '}
          <Text bold={theme.emphasis.inlineKeyBold}>{label}</Text>
          {' needs to be re-authenticated.'}
        </Text>
        <Text color={theme.mutedText} wrap="wrap">
          {modal.message.slice(0, 240)}
        </Text>
        <Box height={1} />
        {modal.status === 'reseeding' ? (
          <Text color={theme.mutedText}>Running owa-piggy reseed...</Text>
        ) : modal.status === 'retrying' ? (
          <Text color={theme.mutedText}>Reseed succeeded; restarting session...</Text>
        ) : (
          <>
            <Text>
              <Text bold={theme.emphasis.inlineKeyBold}>r</Text>
              {'  reseed this profile (runs `owa-piggy reseed`)'}
            </Text>
            <Text>
              <Text bold={theme.emphasis.inlineKeyBold}>s</Text>
              {'  switch to a different profile'}
            </Text>
            <Text>
              <Text bold={theme.emphasis.inlineKeyBold}>q</Text>
              {'  quit teaminal'}
            </Text>
          </>
        )}
        {modal.lastError && (
          <>
            <Box height={1} />
            <Text color={theme.errorText} wrap="wrap">
              {modal.lastError.slice(0, 240)}
            </Text>
          </>
        )}
      </Box>
    </Box>
  )
}
