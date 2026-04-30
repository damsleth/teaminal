// Diagnostics overlay - inspect the live access token and capability probe.
//
// The most useful single thing here is the `scp` claim: if a Graph endpoint
// returns 403 (e.g. presence in some tenants), it usually means the FOCI
// broker token did not include the matching scope (Presence.Read,
// Channel.ReadBasic.All, Group.ReadWrite.All, etc.). The active scope list
// makes that immediately obvious.
//
// Triggered by Help -> Diagnostics in the modal menu. Esc / Enter to close.
// No keys are bound to this beyond closing - it's a read-only inspector.
//
// Anything that would identify the user (oid, sub, upn, full email) is
// shown but not redacted: the user is looking at their own session and
// owns whatever they decide to share.

import { Box, Text, useApp, useInput } from 'ink'
import { useEffect, useState } from 'react'
import { decodeJwtClaims, getToken } from '../auth/owaPiggy'
import type { CapabilityResult } from '../graph/capabilities'
import { getActiveProfile } from '../graph/client'
import { useAppState, useAppStore, useTheme } from './StoreContext'

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
  const modal = useAppState((s) => s.modal)
  const capabilities = useAppState((s) => s.capabilities)
  const me = useAppState((s) => s.me)
  const lastListPollAt = useAppState((s) => s.lastListPollAt)
  const conn = useAppState((s) => s.conn)
  const theme = useTheme()
  const isOpen = modal?.kind === 'diagnostics'

  const [load, setLoad] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setLoad({ status: 'loading' })
    ;(async () => {
      try {
        const token = await getToken()
        const claims = decodeJwtClaims(token)
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
  }, [isOpen])

  useInput(
    (input, key) => {
      if (key.escape || key.return) {
        store.set({ modal: null, inputZone: 'list' })
        return
      }
      if (key.ctrl && input === 'c') exit()
    },
    { isActive: isOpen },
  )

  if (!isOpen) return null

  const profile = getActiveProfile() ?? '(default)'

  return (
    <Box alignItems="center" justifyContent="center" flexGrow={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.borderActive}
        paddingX={3}
        paddingY={1}
      >
        <Text bold>Diagnostics</Text>
        <Box height={1} />

        <Text>
          <Text color="gray">profile: </Text>
          <Text>{profile}</Text>
        </Text>
        <Text>
          <Text color="gray">conn:    </Text>
          <Text>{conn}</Text>
        </Text>
        <Text>
          <Text color="gray">user:    </Text>
          <Text>{me?.displayName ?? '?'}</Text>
          <Text color="gray">{me?.userPrincipalName ? ` <${me.userPrincipalName}>` : ''}</Text>
        </Text>
        <Text>
          <Text color="gray">last poll: </Text>
          <Text>{lastListPollAt ? lastListPollAt.toISOString() : '(none yet)'}</Text>
        </Text>

        <Box height={1} />
        <Text bold>Capabilities</Text>
        {capabilities ? (
          <>
            <CapabilityRow label="me" cap={capabilities.me} theme={theme} />
            <CapabilityRow label="chats" cap={capabilities.chats} theme={theme} />
            <CapabilityRow label="joinedTeams" cap={capabilities.joinedTeams} theme={theme} />
            <CapabilityRow label="presence" cap={capabilities.presence} theme={theme} />
          </>
        ) : (
          <Text color="gray">(probe not yet complete)</Text>
        )}

        <Box height={1} />
        <Text bold>Token</Text>
        {load.status === 'loading' && <Text color="gray">loading...</Text>}
        {load.status === 'error' && (
          <Text color={theme.errorText}>{load.message}</Text>
        )}
        {load.status === 'ready' && (
          <>
            <Text>
              <Text color="gray">tid:     </Text>
              <Text>{asString(load.claims.tid)}</Text>
            </Text>
            <Text>
              <Text color="gray">appid:   </Text>
              <Text>{asString(load.claims.appid ?? load.claims.azp)}</Text>
            </Text>
            <Text>
              <Text color="gray">aud:     </Text>
              <Text>{asString(load.claims.aud)}</Text>
            </Text>
            <Text>
              <Text color="gray">upn:     </Text>
              <Text>{asString(load.claims.upn ?? load.claims.unique_name ?? load.claims.preferred_username)}</Text>
            </Text>
            <Text>
              <Text color="gray">oid:     </Text>
              <Text>{asString(load.claims.oid)}</Text>
            </Text>
            <Text>
              <Text color="gray">exp:     </Text>
              <Text>{formatExp(load.claims.exp)}</Text>
            </Text>
            <Box height={1} />
            <Text bold>Scopes (scp)</Text>
            {asScopeList(load.claims.scp).length > 0 ? (
              asScopeList(load.claims.scp).map((s) => (
                <Text key={s}>
                  <Text color={theme.selected}>{'  · '}</Text>
                  <Text>{s}</Text>
                </Text>
              ))
            ) : (
              <Text color="gray">  (no scp claim - app permission token?)</Text>
            )}
            {Array.isArray(load.claims.roles) && load.claims.roles.length > 0 && (
              <>
                <Box height={1} />
                <Text bold>Roles (app permissions)</Text>
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
        <Text color="gray">esc / enter to close</Text>
      </Box>
    </Box>
  )
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
        <Text color="gray">ok</Text>
      </Text>
    )
  }
  const color =
    cap.reason === 'unauthorized'
      ? theme.errorText
      : cap.reason === 'unavailable'
        ? theme.warnText
        : 'gray'
  const status = cap.status ? ` ${cap.status}` : ''
  return (
    <Text>
      <Text color={color}>● </Text>
      <Text>{label.padEnd(13)}</Text>
      <Text color={color}>{cap.reason}{status}</Text>
    </Text>
  )
}
