import { Box, useApp } from 'ink'
import { Text } from './Text'
import { inkBorder, modalBg } from './theme'
import { useInput } from './useInput'
import { useState } from 'react'
import { accountRef } from '../account'
import { listProfilesFromStatus, reseed, type OwaPiggyProfileStatus } from '../state/authActions'
import { updateSettings } from '../config'
import { applyChatRouting } from '../state/bootstrap'
import {
  accountUnreadCount,
  enabledAccounts,
  nextChatRouting,
  routingForAccount,
  type AccountSlice,
  type Settings,
} from '../state/store'
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
  | { kind: 'retrying'; profile: string; reseeding: boolean }

type RowState = Pick<AccountSlice, 'conn' | 'unreadByChatId' | 'unreadMentionCount'>

// Concurrent mode: what a row says about its account, from its slot.
function rowStatus(slice: RowState | undefined, foreground: boolean): string {
  const conn = slice?.conn
  const state =
    conn === 'authError'
      ? 'auth expired'
      : conn === 'offline'
        ? 'offline'
        : conn === 'connecting' || !slice
          ? 'starting'
          : null
  if (foreground) return state ? `foreground, ${state}` : 'foreground'
  return state ?? 'running'
}

export function AccountsModal() {
  const { exit } = useApp()
  const store = useAppStore()
  const modal = useAppState((s) => s.modal)
  const settings = useAppState((s) => s.settings)
  const theme = useTheme()
  const isOpen = modal?.kind === 'accounts'
  const session = useSessionApi()
  const activeProfile = session.getActiveProfile()
  const concurrent = session.concurrent === true
  // Per-account state for the concurrent rows: the foreground's flat fields
  // and the background slots.
  const foregroundId = useAppState((s) => s.account?.id)
  const foregroundConn = useAppState((s) => s.conn)
  const foregroundUnread = useAppState((s) => s.unreadByChatId)
  const foregroundMentions = useAppState((s) => s.unreadMentionCount)
  const background = useAppState((s) => s.backgroundAccounts)
  const slice = (profile: string): RowState | undefined => {
    const id = accountRef(profile).id
    return id === foregroundId
      ? {
          conn: foregroundConn,
          unreadByChatId: foregroundUnread,
          unreadMentionCount: foregroundMentions,
        }
      : background[id]
  }
  // Opened on a given row (Enter on a failed account's sidebar header).
  const [mode, setMode] = useState<Mode>(() => ({
    kind: 'list',
    cursor: modal?.kind === 'accounts' && modal.mode === 'list' ? modal.cursor : 0,
  }))
  // Close only while this modal is the open one: an async step that ends
  // after the user opened another modal must not close that one.
  const close = () =>
    store.set((s) => (s.modal?.kind === 'accounts' ? { modal: null, inputZone: 'list' } : {}))

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
    // Concurrent mode starts it in the background (no-op otherwise).
    await session.reconcile()
    setMode({ kind: 'list', cursor: accounts.indexOf(profile) })
  }

  async function removeProfile(profile: string): Promise<void> {
    const accounts = settings.accounts.filter((p) => p !== profile)
    const disabledAccounts = settings.disabledAccounts.filter((p) => p !== profile)
    const activeAccount = nextActive(settings.activeAccount, { accounts, disabledAccounts })
    await persist({ accounts, activeAccount, disabledAccounts })
    // Concurrent mode stops and closes it, moving the foreground on first
    // when it was in front (no-op otherwise).
    await session.reconcile()
    // Removing the account that is running must stop showing it: move to the
    // new active account (the default profile when none are left).
    if (session.getActiveProfile() === profile) await session.switchAccount(activeAccount)
    setMode({
      kind: 'list',
      cursor: Math.min(mode.kind === 'confirm-remove' ? 0 : 0, accounts.length),
    })
  }

  // Turn an account off (kept in the list with its routing, favorites and
  // caches, but not started) or on again. Nothing is deleted.
  async function toggleProfile(profile: string): Promise<void> {
    // From the store, not this render: a quick second Space sees the first.
    const current = store.get().settings
    const turningOff = !current.disabledAccounts.includes(profile)
    const disabledAccounts = turningOff
      ? [...current.disabledAccounts, profile]
      : current.disabledAccounts.filter((p) => p !== profile)
    const activeAccount = nextActive(current.activeAccount, {
      accounts: current.accounts,
      disabledAccounts,
    })
    await persist({ disabledAccounts, activeAccount })
    // Concurrent mode stops and closes it, moving the foreground on first
    // (or opens and starts it); no-op otherwise.
    await session.reconcile()
    // Single mode: turning off the running account moves to the next
    // enabled one (the default profile when none is left), like removing it.
    // "Running one that is off", not "running this one": while a switch away
    // from the first is still pending, turning its destination off must move
    // on again instead of letting the switch land on an account that is off.
    const running = session.getActiveProfile()
    if (!concurrent && turningOff && running && disabledAccounts.includes(running)) {
      await session.switchAccount(activeAccount)
    }
  }

  useInput(
    (input, key) => {
      if (!isOpen) return
      const ch = input.toLowerCase()
      if (key.ctrl && ch === 'c') {
        exit()
        return
      }
      if (key.escape) {
        if (mode.kind === 'list') store.set({ modal: null, inputZone: 'list' })
        else setMode({ kind: 'list', cursor: 0 })
        return
      }
      if (mode.kind === 'loading' || mode.kind === 'retrying') return
      if (mode.kind === 'confirm-remove') {
        if (ch === 'y' || key.return) {
          void removeProfile(mode.profile).catch((err) => {
            setMode({
              kind: 'list',
              cursor: 0,
              error: err instanceof Error ? err.message : String(err),
            })
          })
        } else if (ch === 'n') {
          setMode({ kind: 'list', cursor: 0 })
        }
        return
      }
      if (mode.kind === 'pick') {
        if (ch === 'j' || key.downArrow) {
          setMode({ ...mode, cursor: clamp(mode.cursor + 1, mode.profiles.length) })
          return
        }
        if (ch === 'k' || key.upArrow) {
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
      if (ch === 'a') {
        void scanProfiles()
        return
      }
      const rowCount = settings.accounts.length
      if (ch === 'j' || key.downArrow) {
        setMode({ ...mode, cursor: clamp(mode.cursor + 1, rowCount) })
        return
      }
      if (ch === 'k' || key.upArrow) {
        setMode({ ...mode, cursor: clamp(mode.cursor - 1, rowCount) })
        return
      }
      if ((ch === 'd' || key.delete) && settings.accounts.length > 0) {
        const profile = settings.accounts[clamp(mode.cursor, settings.accounts.length)]
        if (profile) setMode({ kind: 'confirm-remove', profile })
        return
      }
      if (input === ' ' && settings.accounts.length > 0) {
        const cursor = clamp(mode.cursor, settings.accounts.length)
        const profile = settings.accounts[cursor]
        if (!profile) return
        void toggleProfile(profile).catch((err) => {
          setMode({
            kind: 'list',
            cursor,
            error: `${profile}: ${err instanceof Error ? err.message : String(err)}`,
          })
        })
        return
      }
      // Cycle the focused account's chat routing mode
      // (graph+ic3 → ic3+graph → ic3-only → graph-only).
      if (ch === 't' && settings.accounts.length > 0) {
        const profile = settings.accounts[clamp(mode.cursor, settings.accounts.length)]
        if (!profile) return
        const next = nextChatRouting(routingForAccount(settings, profile))
        const chatRoutingByAccount = { ...settings.chatRoutingByAccount, [profile]: next }
        void persist({ chatRoutingByAccount }).then(() => {
          // The session client reads the new mode on its next call; also
          // clear this account's chatsvc latch taken under the old one.
          applyChatRouting(accountRef(profile))
        })
        return
      }
      // Concurrent mode: start a failed account again; auth expiry reseeds
      // the owa-piggy profile first.
      if (ch === 'r' && concurrent && settings.accounts.length > 0) {
        const cursor = clamp(mode.cursor, settings.accounts.length)
        const profile = settings.accounts[cursor]
        const conn = profile ? slice(profile)?.conn : undefined
        if (!profile || (conn !== 'authError' && conn !== 'offline')) return
        const reseeding = conn === 'authError'
        setMode({ kind: 'retrying', profile, reseeding })
        void (async () => {
          try {
            if (reseeding) await reseed({ profile })
            await session.retry(profile)
            setMode({ kind: 'list', cursor })
          } catch (err) {
            setMode({
              kind: 'list',
              cursor,
              error: `${profile}: ${err instanceof Error ? err.message : String(err)}`,
            })
          }
        })()
        return
      }
      // Enter switches to the selected account.
      if (key.return && settings.accounts.length > 0) {
        const profile = settings.accounts[clamp(mode.cursor, settings.accounts.length)]
        if (!profile) return
        if (settings.disabledAccounts.includes(profile)) {
          setMode({ ...mode, error: `${profile} is off: Space turns it on` })
          return
        }
        if (settings.activeAccount === profile && session.getActiveProfile() === profile) {
          // Already active; close the modal as a no-op.
          store.set({ modal: null, inputZone: 'list' })
          return
        }
        void (async () => {
          try {
            if (concurrent) {
              // Instant: the account already runs (or shows why it does
              // not). The swap closes this modal, or opens auth-expired.
              session.setForeground(profile)
              close()
              await persist({ activeAccount: profile })
              return
            }
            await persist({ activeAccount: profile })
            await session.switchAccount(profile)
            close()
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
        borderStyle={inkBorder(theme.borders.modal)}
        borderColor={theme.borderActive}
        backgroundColor={modalBg(theme)}
        paddingX={theme.layout.modalPaddingX}
        paddingY={theme.layout.modalPaddingY}
        width={70}
        maxWidth="100%"
      >
        <Text bold={theme.emphasis.modalTitleBold}>Accounts</Text>
        <Box height={1} />
        {mode.kind === 'loading' ? (
          <Text color={theme.mutedText}>Checking owa-piggy profiles...</Text>
        ) : mode.kind === 'retrying' ? (
          <Text color={theme.mutedText}>
            {mode.reseeding
              ? `Reseeding ${mode.profile} (owa-piggy reseed), then restarting...`
              : `Restarting ${mode.profile}...`}
          </Text>
        ) : mode.kind === 'pick' ? (
          <>
            <Text color={theme.mutedText}>Select an account to add</Text>
            {mode.profiles.map((profile, i) => (
              <Text
                key={profile.profile}
                color={i === mode.cursor ? theme.selected : undefined}
                bold={i === mode.cursor && theme.emphasis.selectedBold}
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
                  bold={i === mode.cursor && theme.emphasis.selectedBold}
                >
                  {i === mode.cursor ? '> ' : '  '}
                  {profile}
                  {concurrent ? (
                    <Text color={theme.mutedText}>
                      {settings.disabledAccounts.includes(profile)
                        ? '  off'
                        : `  ${rowStatus(slice(profile), accountRef(profile).id === foregroundId)}`}
                      {`  [${routingForAccount(settings, profile)}]`}
                      {unreadSuffix(slice(profile))}
                    </Text>
                  ) : (
                    <Text color={theme.mutedText}>
                      {activeProfile === profile ? '  active' : ''}
                      {settings.disabledAccounts.includes(profile) ? '  off' : ''}
                      {`  [${routingForAccount(settings, profile)}]`}
                    </Text>
                  )}
                </Text>
              ))
            )}
            {mode.error && <Text color={theme.errorText}>{mode.error.slice(0, 180)}</Text>}
            <Box height={1} />
            <Text color={theme.mutedText}>
              Enter switch · a add · d remove · Space on/off · t routing
              (graph+ic3/ic3+graph/ic3-only/graph-only)
              {concurrent ? ' · r retry failed' : ''} · Esc close
            </Text>
          </>
        )}
      </Box>
    </Box>
  )
}

// activeAccount after the account list changed: kept while it is enabled,
// else the first enabled account (null when none is left).
function nextActive(
  activeAccount: string | null,
  settings: Pick<Settings, 'accounts' | 'disabledAccounts'>,
): string | null {
  const enabled = enabledAccounts(settings)
  return activeAccount === null || enabled.includes(activeAccount)
    ? activeAccount
    : (enabled[0] ?? null)
}

function unreadSuffix(slice: RowState | undefined): string {
  const n = slice ? accountUnreadCount(slice) : 0
  return n > 0 ? `  ${n} unread` : ''
}

function clamp(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(length - 1, index))
}
