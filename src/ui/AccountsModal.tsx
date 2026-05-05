import { Box, Text, useApp, useInput } from 'ink'
import { useState } from 'react'
import { listProfilesFromStatus, type OwaPiggyProfileStatus } from '../auth/owaPiggy'
import { updateSettings } from '../config'
import type { Settings } from '../state/store'
import { useSessionApi } from './SessionContext'
import { useAppState, useAppStore, useTheme } from './StoreContext'

type Mode =
  | { kind: 'list'; cursor: number; error?: string }
  | { kind: 'loading' }
  | {
      kind: 'pick'
      cursor: number
      profiles: OwaPiggyProfileStatus[]
      invalid: OwaPiggyProfileStatus[]
    }
  | { kind: 'confirm-remove'; profile: string }

export function AccountsModal() {
  const { exit } = useApp()
  const store = useAppStore()
  const modal = useAppState((s) => s.modal)
  const settings = useAppState((s) => s.settings)
  const theme = useTheme()
  const isOpen = modal?.kind === 'accounts'
  const session = useSessionApi()
  const [mode, setMode] = useState<Mode>({ kind: 'list', cursor: 0 })

  async function persist(patch: Partial<Settings>): Promise<void> {
    const next = await updateSettings(patch)
    store.set({ settings: next })
  }

  async function scanProfiles(): Promise<void> {
    setMode({ kind: 'loading' })
    try {
      const profiles = await listProfilesFromStatus()
      const valid = profiles.filter((p) => p.valid)
      const invalid = profiles.filter((p) => !p.valid)
      if (valid.length === 0) {
        const suffix =
          invalid.length > 0
            ? ` (${invalid.length} accounts found with invalid tokens: ${invalid.map((p) => p.profile).join(', ')})`
            : ''
        setMode({
          kind: 'list',
          cursor: 0,
          error: `No accounts with valid tokens found${suffix}. Please run \`owa-piggy setup --profile <profilename>\` to authenticate an account, then try again.`,
        })
        return
      }
      setMode({ kind: 'pick', cursor: 0, profiles: valid, invalid })
    } catch (err) {
      setMode({
        kind: 'list',
        cursor: 0,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async function addProfile(profile: string): Promise<void> {
    const accounts = [...new Set([...settings.accounts, profile])]
    await persist({
      accounts,
      activeAccount: settings.activeAccount ?? profile,
    })
    setMode({ kind: 'list', cursor: accounts.indexOf(profile) })
  }

  async function removeProfile(profile: string): Promise<void> {
    const accounts = settings.accounts.filter((p) => p !== profile)
    await persist({
      accounts,
      activeAccount:
        settings.activeAccount === profile ? (accounts[0] ?? null) : settings.activeAccount,
    })
    setMode({
      kind: 'list',
      cursor: Math.min(mode.kind === 'confirm-remove' ? 0 : 0, accounts.length),
    })
  }

  useInput(
    (input, key) => {
      if (!isOpen) return
      if (key.ctrl && input === 'c') {
        exit()
        return
      }
      if (key.escape) {
        if (mode.kind === 'list') store.set({ modal: null, inputZone: 'list' })
        else setMode({ kind: 'list', cursor: 0 })
        return
      }
      if (mode.kind === 'loading') return
      if (mode.kind === 'confirm-remove') {
        if (input === 'y' || input === 'Y' || key.return) {
          void removeProfile(mode.profile).catch((err) => {
            setMode({
              kind: 'list',
              cursor: 0,
              error: err instanceof Error ? err.message : String(err),
            })
          })
        } else if (input === 'n' || input === 'N') {
          setMode({ kind: 'list', cursor: 0 })
        }
        return
      }
      if (mode.kind === 'pick') {
        if (input === 'j' || key.downArrow) {
          setMode({ ...mode, cursor: clamp(mode.cursor + 1, mode.profiles.length) })
          return
        }
        if (input === 'k' || key.upArrow) {
          setMode({ ...mode, cursor: clamp(mode.cursor - 1, mode.profiles.length) })
          return
        }
        if (key.return) {
          const selected = mode.profiles[clamp(mode.cursor, mode.profiles.length)]
          if (!selected) return
          void addProfile(selected.profile).catch((err) => {
            setMode({
              kind: 'list',
              cursor: 0,
              error: err instanceof Error ? err.message : String(err),
            })
          })
          return
        }
        return
      }
      if (input === 'A') {
        void scanProfiles()
        return
      }
      const rowCount = settings.accounts.length
      if (input === 'j' || key.downArrow) {
        setMode({ ...mode, cursor: clamp(mode.cursor + 1, rowCount) })
        return
      }
      if (input === 'k' || key.upArrow) {
        setMode({ ...mode, cursor: clamp(mode.cursor - 1, rowCount) })
        return
      }
      if ((input === 'D' || key.delete) && settings.accounts.length > 0) {
        const profile = settings.accounts[clamp(mode.cursor, settings.accounts.length)]
        if (profile) setMode({ kind: 'confirm-remove', profile })
        return
      }
      // Enter switches to the selected account.
      if (key.return && settings.accounts.length > 0) {
        const profile = settings.accounts[clamp(mode.cursor, settings.accounts.length)]
        if (!profile) return
        if (settings.activeAccount === profile && session.getActiveProfile() === profile) {
          // Already active; close the modal as a no-op.
          store.set({ modal: null, inputZone: 'list' })
          return
        }
        void (async () => {
          try {
            await persist({ activeAccount: profile })
            await session.switchAccount(profile)
            store.set({ modal: null, inputZone: 'list' })
          } catch (err) {
            setMode({
              kind: 'list',
              cursor: 0,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        })()
      }
    },
    { isActive: isOpen },
  )

  if (!isOpen) return null

  return (
    <Box alignItems="center" justifyContent="center" flexGrow={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.borderActive}
        paddingX={3}
        paddingY={1}
      >
        <Text bold>Accounts</Text>
        <Box height={1} />
        {mode.kind === 'loading' ? (
          <Text color={theme.mutedText}>Checking owa-piggy profiles...</Text>
        ) : mode.kind === 'pick' ? (
          <>
            <Text color={theme.mutedText}>Select an account to add</Text>
            {mode.profiles.map((profile, i) => (
              <Text
                key={profile.profile}
                color={i === mode.cursor ? theme.selected : undefined}
                bold={i === mode.cursor}
              >
                {i === mode.cursor ? '> ' : '  '}
                {profile.profile}
                <Text color={theme.mutedText}>
                  {profile.accessTokenExpiresAt ? `  token ${profile.accessTokenExpiresAt}` : ''}
                </Text>
              </Text>
            ))}
          </>
        ) : mode.kind === 'confirm-remove' ? (
          <>
            <Text>{`Remove ${mode.profile} from teaminal accounts?`}</Text>
            <Text color={theme.mutedText}>y/Enter confirms, n/Esc cancels</Text>
          </>
        ) : (
          <>
            {settings.accounts.length === 0 ? (
              <Text color={theme.mutedText}>No accounts added.</Text>
            ) : (
              settings.accounts.map((profile, i) => (
                <Text
                  key={profile}
                  color={i === mode.cursor ? theme.selected : undefined}
                  bold={i === mode.cursor}
                >
                  {i === mode.cursor ? '> ' : '  '}
                  {profile}
                  <Text color={theme.mutedText}>
                    {settings.activeAccount === profile ? '  active' : ''}
                  </Text>
                </Text>
              ))
            )}
            {mode.error && <Text color={theme.errorText}>{mode.error.slice(0, 180)}</Text>}
            <Box height={1} />
            <Text color={theme.mutedText}>
              Enter switch · A add account · D/Delete remove · Esc close
            </Text>
          </>
        )}
      </Box>
    </Box>
  )
}

function clamp(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(length - 1, index))
}
