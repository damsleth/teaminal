// New-chat prompt overlay.
//
// Owns its own input via Ink useInput while open. Debounces typing into
// a Graph people search; on Enter, hands the chosen DirectoryUser back
// to its parent which decides whether to open an existing chat or
// create a new one.

import { Box, Text, useApp, useInput } from 'ink'
import { useEffect, useState } from 'react'
import { searchChatUsers } from '../graph/chats'
import { searchExternalUsers } from '../graph/teamsExternalSearch'
import { clampCursor } from '../state/selectables'
import type { DirectoryUser } from '../types'
import { isNewChatQueryCandidate } from './ChatList'

const DEBOUNCE_MS = 250
const RESULT_LIMIT = 5
type PromptZone = 'input' | 'results'

function looksLikeEmail(query: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(query.trim())
}

export function NewChatPrompt(props: {
  initialQuery: string
  onClose: () => void
  onSelectUser: (user: DirectoryUser) => Promise<void>
}) {
  const { exit } = useApp()
  const [query, setQuery] = useState(props.initialQuery)
  const [results, setResults] = useState<DirectoryUser[]>([])
  const [cursor, setCursor] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [zone, setZone] = useState<PromptZone>('input')
  const [externalLookup, setExternalLookup] = useState<'idle' | 'in-flight' | 'no-hit'>('idle')

  useEffect(() => {
    const q = query.trim()
    if (!isNewChatQueryCandidate(q)) {
      setResults([])
      setCursor(0)
      setError(null)
      return
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => {
      setLoading(true)
      setError(null)
      searchChatUsers(q, { top: RESULT_LIMIT, signal: ctrl.signal })
        .then((users) => {
          setResults(users)
          setCursor(0)
        })
        .catch((err) => {
          if (ctrl.signal.aborted) return
          setError(err instanceof Error ? err.message : 'search failed')
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setLoading(false)
        })
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      ctrl.abort()
    }
  }, [query])

  useEffect(() => {
    if (results.length === 0 && zone === 'results') setZone('input')
  }, [results.length, zone])

  useInput(
    (input, key) => {
      const ch = input.toLowerCase()
      if (key.escape) {
        props.onClose()
        return
      }
      if (key.ctrl && ch === 'c') {
        exit()
        return
      }
      if (key.tab) {
        if (results.length > 0) setZone((z) => (z === 'input' ? 'results' : 'input'))
        return
      }
      if (zone === 'results') {
        if (ch === 'j' || key.downArrow) {
          setCursor((c) => clampCursor(c + 1, results.length))
          return
        }
        if (ch === 'k' || key.upArrow) {
          setCursor((c) => clampCursor(c - 1, results.length))
          return
        }
      }
      if (key.return) {
        if (loading || externalLookup === 'in-flight') return
        const selected = results[clampCursor(cursor, results.length)]
        if (selected) {
          setLoading(true)
          setError(null)
          props.onSelectUser(selected).catch((err) => {
            setError(err instanceof Error ? err.message : 'create chat failed')
            setLoading(false)
          })
          return
        }
        // No Graph results. If the typed query looks like an email,
        // fall back to the Teams external-tenant search before
        // surrendering. This is the only path that reaches users in
        // unlinked tenants.
        const trimmed = query.trim()
        if (results.length === 0 && looksLikeEmail(trimmed)) {
          setExternalLookup('in-flight')
          setError(null)
          searchExternalUsers(trimmed, { top: RESULT_LIMIT })
            .then((users) => {
              if (users.length === 0) {
                setExternalLookup('no-hit')
                return
              }
              setResults(users)
              setCursor(0)
              setZone('results')
              setExternalLookup('idle')
            })
            .catch((err) => {
              setExternalLookup('idle')
              setError(err instanceof Error ? err.message : 'external search failed')
            })
        }
        return
      }
      if (key.backspace || key.delete) {
        setZone('input')
        setQuery((q) => q.slice(0, -1))
        return
      }
      if (input && !key.ctrl && !key.meta) {
        setZone('input')
        setQuery((q) => q + input)
      }
    },
    { isActive: true },
  )

  return (
    <Box alignItems="center" justifyContent="center" flexGrow={1}>
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={3} paddingY={1}>
        <Text bold>New chat</Text>
        <Box height={1} />
        <Text>
          <Text color="gray">To: </Text>
          {query}
          <Text color={zone === 'input' ? 'cyan' : 'gray'}>█</Text>
        </Text>
        {loading && <Text color="gray">Searching...</Text>}
        {externalLookup === 'in-flight' && (
          <Text color="gray">Searching external tenants for {query.trim()}...</Text>
        )}
        {externalLookup === 'no-hit' && (
          <Text color="gray">No external match for {query.trim()}</Text>
        )}
        {error && <Text color="red">{error.slice(0, 120)}</Text>}
        {!loading &&
          !error &&
          externalLookup === 'idle' &&
          results.length === 0 &&
          query.trim() && <Text color="gray">No matches (Enter to search externally)</Text>}
        {results.map((user, i) => {
          const selected = zone === 'results' && i === clampCursor(cursor, results.length)
          const detail = user.mail ?? user.userPrincipalName ?? user.id
          return (
            <Text key={user.id} color={selected ? 'cyan' : undefined} bold={selected}>
              {selected ? '> ' : '  '}
              {user.displayName ?? detail}
              <Text color="gray">{`  ${detail}`}</Text>
            </Text>
          )
        })}
        <Box height={1} />
        <Text color="gray">Tab results · Enter opens selected 1:1 chat · Esc closes</Text>
      </Box>
    </Box>
  )
}
