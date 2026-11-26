// Redacted shape of a trouter frame, for TEAMINAL_TROUTER_CAPTURE.
//
// Pure. The output is built only from constants: allowlisted event names,
// payload keys and path segments, `typeof` names, `:other` and counts. No
// substring of the frame ever reaches it, so ids, tokens, addresses, query
// credentials and message text cannot leak, whatever the frame holds.
// (`redactRequestPath` in src/log.ts is a heuristic for Graph paths and is
// deliberately not used here.)

import type { RealtimeEventKind } from './events'

export type FrameOuterKind = '1::' | '2::' | '3' | '5' | 'json' | 'other'

const EVENT_NAMES = ['trouter.connected', 'trouter.message_loss'] as const

const PAYLOAD_KEYS = [
  'eventType',
  'resource',
  'resourceData',
  'body',
  'type',
  'time',
  'id',
  'ccid',
  'url',
  'surl',
  'socketio',
  'registrarUrl',
  'reconnectUrl',
  'connectparams',
  'ttl',
  'tag',
  'headers',
] as const

const RESOURCE_SEGMENTS = [
  'v1',
  'beta',
  'me',
  'users',
  'chats',
  'conversations',
  'threads',
  'teams',
  'channels',
  'messages',
  'members',
  'typing',
  'properties',
] as const

const MAX_SEGMENTS = 8

export function outerKind(raw: string): FrameOuterKind {
  if (raw === '1::' || raw === '2::') return raw
  if (raw.startsWith('3:')) return '3'
  if (raw.startsWith('5:')) return '5'
  if (/^\s*[{[]/.test(raw)) return 'json'
  return 'other'
}

// One line, for example
// `outer=5 name=other keys=eventType,resource,+1 resource=string:/chats/:other/messages kinds=new-message`.
// `kinds` are what the transport mapped the frame to (it maps once, in its
// handling path, and passes them in).
export function describeFrame(raw: string, kinds: readonly RealtimeEventKind[] = []): string {
  const outer = outerKind(raw)
  const parts = [`outer=${outer}`]
  let payload: unknown
  if (outer === '5') {
    const event = parseJson(/^5:[^:]*::([\s\S]*)$/.exec(raw)?.[1])
    if (isObject(event)) {
      parts.push(`name=${EVENT_NAMES.find((n) => n === event.name) ?? 'other'}`)
      payload = Array.isArray(event.args) ? event.args[0] : undefined
    } else {
      parts.push('parse=failed')
    }
  } else if (outer === 'json') {
    const obj = parseJson(raw)
    if (obj === undefined) parts.push('parse=failed')
    else payload = isObject(obj) && isObject(obj.body) ? obj.body : obj
  }
  if (isObject(payload)) {
    parts.push(`keys=${keyList(payload)}`, `resource=${resourceShape(payload.resource)}`)
  } else if (payload !== undefined) {
    parts.push(`payload=${typeName(payload)}`)
  }
  parts.push(`kinds=${kinds.length > 0 ? kinds.join(',') : 'none'}`)
  return parts.join(' ')
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function typeName(v: unknown): string {
  if (v === undefined) return 'absent'
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

// Allowlisted key names in allowlist order, the rest counted (key names can
// themselves be ids).
function keyList(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj)
  const known: string[] = PAYLOAD_KEYS.filter((k) => keys.includes(k))
  const extra = keys.length - known.length
  if (extra > 0) known.push(`+${extra}`)
  return known.length > 0 ? known.join(',') : '-'
}

// `string:<template>` with allowlisted segments kept, `name(...)` keys
// reduced to `name(:other)` and every other segment `:other`; any other
// type is its type name.
function resourceShape(v: unknown): string {
  if (typeof v !== 'string') return typeName(v)
  const q = v.indexOf('?')
  const segments = (q >= 0 ? v.slice(0, q) : v).split('/')
  const template = segments
    .slice(0, MAX_SEGMENTS)
    .map((seg) => {
      if (seg === '') return ''
      const m = /^([A-Za-z0-9]+)(\(.*\))?$/.exec(seg)
      const name = m && RESOURCE_SEGMENTS.find((s) => s === m[1]!.toLowerCase())
      if (!name) return ':other'
      return m[2] ? `${name}(:other)` : name
    })
    .join('/')
  const more = segments.length > MAX_SEGMENTS ? '/…' : ''
  return `string:${template}${more}${q >= 0 ? '?:other' : ''}`
}
