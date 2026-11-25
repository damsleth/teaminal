// Diagnostics overlay - inspect the live access token and capability probe.
//
// The most useful single thing here is the `scp` claim: if a Graph endpoint
// returns 403 (e.g. channel listing in some tenants), it usually means the
// FOCI broker token did not include the matching scope
// (Channel.ReadBasic.All, Group.ReadWrite.All, etc.). The active scope list
// makes that immediately obvious. The presence probe targets the Teams
// unified presence endpoint (presence.teams.microsoft.com / PresenceRW),
// not Graph /me/presence, since the Teams path is what the runtime uses.
//
// Triggered by Help -> Diagnostics in the modal menu. Esc / Enter to close.
// With more than one account open, an overview lists every account (j/k
// selects); the detail below and `r` act on the selected one.
//
// Anything that would identify the user (oid, sub, upn, full email) is
// shown but not redacted: the user is looking at their own session and
// owns whatever they decide to share.

import { Box, useApp } from 'ink'
import { Text } from './Text'
import { inkBorder, modalBg } from './theme'
import { useInput } from './useInput'
import { fitCells } from './textSizing'
import { useEffect, useMemo, useState } from 'react'
import type { AccountId } from '../account'
import { accessTokenClaims } from '../state/authActions'
import { accountDiagnostics, type AccountDiagnostics } from '../state/diagnostics'
import { accountSlice } from '../state/store'
import type { CapabilityResult } from '../graph/capabilities'
import { useAppState, useAppStore, useTheme } from './StoreContext'
import { useSessionApi } from './SessionContext'

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; claims: Record<string, unknown> }
  | { status: 'error'; message: string }

export function openDiagnostics(store: ReturnType<typeof useAppStore>): void {
  store.set({ modal: { kind: 'diagnostics' }, inputZone: 'menu' })
}

function formatExp(exp: unknown): string {
  if (typeof exp !== 'number') return '?'
  const date = new Date(exp * 1000)
  const remaining = Math.max(0, exp - Math.floor(Date.now() / 1000))
  const min = Math.floor(remaining / 60)
  return `${date.toISOString()} (in ${min}m)`
}

function asString(v: unknown): string {
  return v == null ? '?' : String(v)
}

function asScopeList(scp: unknown): string[] {
  if (typeof scp !== 'string') return []
  return scp.split(/\s+/).filter(Boolean).sort()
}

export function DiagnosticsModal() {
  const { exit } = useApp()
  const store = useAppStore()
  const session = useSessionApi()
  // App mounts this only while Diagnostics is open, so following the whole
  // state costs nothing on the typing path.
  const state = useAppState((s) => s)
  const theme = useTheme()
  const isOpen = state.modal?.kind === 'diagnostics'

  // Every open account; the overview shows when there is more than one.
  const rows = useMemo(() => accountDiagnostics(state), [state])
  const [selectedId, setSelectedId] = useState<AccountId | null>(null)
  useEffect(() => {
    if (isOpen) setSelectedId(state.account?.id ?? null)
  }, [isOpen])
  const selected = rows.find((r) => r.ref.id === selectedId) ?? rows.find((r) => r.foreground)
  const selectedIsForeground = !selected || selected.foreground
  // The detail reads the selected account's slot (the flat fields for the
  // foreground).
  const slice = (selected && accountSlice(state, selected.ref.id)) || state
  const { capabilities, me, lastListPollAt, conn, realtimeState } = slice
  const { chats, teams, channelsByTeam, messagesByConvo } = slice
  const { terminalFocused, focusReportingHealthy } = state

  const [load, setLoad] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setLoad({ status: 'loading' })
    ;(async () => {
      try {
        // The selected account's token, not the default profile's.
        const claims = await accessTokenClaims(
          selectedIsForeground ? session.client() : session.clientFor(selected.ref.id),
        )
        if (cancelled) return
        setLoad({ status: 'ready', claims })
      } catch (err) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setLoad({ status: 'error', message })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isOpen, selected?.ref.id])

  useInput(
    (input, key) => {
      const ch = input.toLowerCase()
      if (key.escape || key.return) {
        store.set({ modal: null, inputZone: 'list' })
        return
      }
      if (key.ctrl && ch === 'c') exit()
      if (rows.length > 1 && (ch === 'j' || ch === 'k' || key.downArrow || key.upArrow)) {
        const i = rows.findIndex((r) => r.ref.id === selected?.ref.id)
        const step = ch === 'k' || key.upArrow ? -1 : 1
        setSelectedId(rows[(i + step + rows.length) % rows.length]!.ref.id)
        return
      }
      if (ch === 'r') {
        // Manual realtime push retry — useful when the dot has been red
        // for a while because trouter exhausted its automatic retries.
        session.retryRealtime(selectedIsForeground ? undefined : selected.ref.id)
      }
    },
    { isActive: isOpen },
  )

  if (!isOpen) return null

  const profile = selectedIsForeground
    ? (session.getActiveProfile() ?? '(default)')
    : selected.ref.label

  return (
    <Box alignItems="center" justifyContent="center" flexGrow={1}>
      <Box
        flexDirection="column"
        borderStyle={inkBorder(theme.borders.modal)}
        borderColor={theme.borderActive}
        backgroundColor={modalBg(theme)}
        paddingX={theme.layout.modalPaddingX}
        paddingY={theme.layout.modalPaddingY}
        width={80}
        maxWidth="100%"
      >
        <Text bold={theme.emphasis.modalTitleBold}>Diagnostics</Text>
        <Box height={1} />
        {rows.length > 1 && <Overview rows={rows} selected={selected} theme={theme} />}

        <Text>
          <Text muted>profile: </Text>
          <Text>{profile}</Text>
        </Text>
        <Text>
          <Text muted>conn: </Text>
          <Text>{conn}</Text>
        </Text>
        <Text>
          <Text muted>realtime: </Text>
          <Text>{realtimeState}</Text>
        </Text>
        <Text>
          <Text muted>user: </Text>
          <Text>{me?.displayName ?? '?'}</Text>
          <Text muted>{me?.userPrincipalName ? ` <${me.userPrincipalName}>` : ''}</Text>
        </Text>
        <Text>
          <Text muted>last poll: </Text>
          <Text>{lastListPollAt ? lastListPollAt.toISOString() : '(none yet)'}</Text>
        </Text>
        <Text>
          <Text muted>loaded: </Text>
          <Text>{`${chats.length} chats, ${teams.length} teams, ${countChannels(channelsByTeam)} channels, ${countMessages(messagesByConvo)} messages`}</Text>
        </Text>
        <Text>
          <Text muted>focus: </Text>
          <Text>{terminalFocused ? 'focused' : 'blurred'}</Text>
          <Text muted>
            {' · DEC 1004: '}
            {focusReportingHealthy ? 'healthy' : 'unhealthy (fallback)'}
          </Text>
        </Text>

        <Box height={1} />
        <Text bold={theme.emphasis.sectionHeadingBold}>Capabilities</Text>
        {capabilities ? (
          <>
            <CapabilityRow label="me" cap={capabilities.me} theme={theme} />
            <CapabilityRow label="chats" cap={capabilities.chats} theme={theme} />
            <CapabilityRow label="joinedTeams" cap={capabilities.joinedTeams} theme={theme} />
            <CapabilityRow label="presence" cap={capabilities.presence} theme={theme} />
          </>
        ) : (
          <Text muted>(probe not yet complete)</Text>
        )}

        <Box height={1} />
        <Text bold={theme.emphasis.sectionHeadingBold}>Token</Text>
        {load.status === 'loading' && <Text muted>loading...</Text>}
        {load.status === 'error' && <Text color={theme.errorText}>{load.message}</Text>}
        {load.status === 'ready' && (
          <>
            <Text>
              <Text muted>tid: </Text>
              <Text>{asString(load.claims.tid)}</Text>
            </Text>
            <Text>
              <Text muted>appid: </Text>
              <Text>{asString(load.claims.appid ?? load.claims.azp)}</Text>
            </Text>
            <Text>
              <Text muted>aud: </Text>
              <Text>{asString(load.claims.aud)}</Text>
            </Text>
            <Text>
              <Text muted>upn: </Text>
              <Text>
                {asString(
                  load.claims.upn ?? load.claims.unique_name ?? load.claims.preferred_username,
                )}
              </Text>
            </Text>
            <Text>
              <Text muted>oid: </Text>
              <Text>{asString(load.claims.oid)}</Text>
            </Text>
            <Text>
              <Text muted>exp: </Text>
              <Text>{formatExp(load.claims.exp)}</Text>
            </Text>
            <Box height={1} />
            <Text bold={theme.emphasis.sectionHeadingBold}>Scopes (scp)</Text>
            {asScopeList(load.claims.scp).length > 0 ? (
              asScopeList(load.claims.scp).map((s) => (
                <Text key={s}>
                  <Text color={theme.selected}>{'  · '}</Text>
                  <Text>{s}</Text>
                </Text>
              ))
            ) : (
              <Text muted> (no scp claim - app permission token?)</Text>
            )}
            {Array.isArray(load.claims.roles) && load.claims.roles.length > 0 && (
              <>
                <Box height={1} />
                <Text bold={theme.emphasis.sectionHeadingBold}>Roles (app permissions)</Text>
                {(load.claims.roles as unknown[]).map((r, i) => (
                  <Text key={i}>
                    <Text color={theme.selected}>{'  · '}</Text>
                    <Text>{String(r)}</Text>
                  </Text>
                ))}
              </>
            )}
          </>
        )}

        <Box height={1} />
        <Text muted>
          {rows.length > 1 ? 'j/k: account · ' : ''}r: retry realtime · esc / enter to close
        </Text>
      </Box>
    </Box>
  )
}

// One row per open account, two lines each: status, then cache files.
function Overview(props: {
  rows: AccountDiagnostics[]
  selected: AccountDiagnostics | undefined
  theme: ReturnType<typeof useTheme>
}) {
  const { rows, selected, theme } = props
  const labelWidth = Math.min(10, Math.max(7, ...rows.map((r) => Bun.stringWidth(r.ref.label))))
  return (
    <>
      <Text muted>
        {`  ${fitCells('account', labelWidth)} ${fitCells('conn', 11)} ${fitCells('realtime', 12)} ${fitCells('last poll', 9)} ${fitCells('routing', 10)} caps`}
      </Text>
      {rows.map((r) => {
        const isSelected = r.ref.id === selected?.ref.id
        const poll = r.lastListPollAt ? r.lastListPollAt.toTimeString().slice(0, 8) : '-'
        return (
          <Box key={r.ref.id} flexDirection="column">
            <Text>
              <Text color={theme.selected}>{isSelected ? '▸ ' : '  '}</Text>
              <Text bold={isSelected}>{fitCells(r.ref.label, labelWidth)}</Text>
              <Text
                color={r.conn === 'online' ? undefined : theme.warnText}
              >{` ${fitCells(r.conn, 11)}`}</Text>
              <Text>{` ${fitCells(r.realtimeState, 12)} ${fitCells(poll, 9)} ${fitCells(r.routing, 10)} `}</Text>
              <Text muted>{r.capabilities}</Text>
            </Text>
            <Text muted>{`    ${compactCachePaths(r.cachePaths)}`}</Text>
          </Box>
        )
      })}
      <Box height={1} />
    </>
  )
}

// `<dir>/{messages,list,names}.<slug>.json` for the three cache files.
function compactCachePaths(paths: readonly string[]): string {
  const home = process.env.HOME
  const short = paths.map((p) =>
    home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p,
  )
  const dir = short[0]!.slice(0, short[0]!.lastIndexOf('/') + 1)
  if (!short.every((p) => p.startsWith(dir))) return short.join(' · ')
  const names = short.map((p) => p.slice(dir.length))
  const suffix = names[0]!.slice(names[0]!.indexOf('.'))
  if (!names.every((n) => n.endsWith(suffix))) return short.join(' · ')
  return `${dir}{${names.map((n) => n.slice(0, -suffix.length)).join(',')}}${suffix}`
}

function countChannels(channelsByTeam: Record<string, unknown[]>): number {
  return Object.values(channelsByTeam).reduce((sum, channels) => sum + channels.length, 0)
}

function countMessages(messagesByConvo: Record<string, unknown[]>): number {
  return Object.values(messagesByConvo).reduce((sum, messages) => sum + messages.length, 0)
}

function CapabilityRow(props: {
  label: string
  cap: CapabilityResult
  theme: ReturnType<typeof useTheme>
}) {
  const { label, cap, theme } = props
  if (cap.ok) {
    return (
      <Text>
        <Text color={theme.presence.Available}>● </Text>
        <Text>{label.padEnd(13)}</Text>
        <Text muted>ok</Text>
      </Text>
    )
  }
  const color =
    cap.reason === 'unauthorized'
      ? theme.errorText
      : cap.reason === 'unavailable'
        ? theme.warnText
        : theme.mutedText
  const status = cap.status ? ` ${cap.status}` : ''
  return (
    <Text>
      <Text color={color}>● </Text>
      <Text>{label.padEnd(13)}</Text>
      <Text color={color}>
        {cap.reason}
        {status}
      </Text>
    </Text>
  )
}
