// Decoder for Graph systemEventMessage rows.
//
// Graph attaches a typed `eventDetail` payload describing what happened
// (chat created, member added, topic changed, call ended, meeting
// started, etc.). We render a short human-readable string per known
// subtype and return null for everything else so the caller can drop
// the row entirely - we'd rather hide an undecoded event than render
// "(system event)" with no detail.

import type { ChatMessage, SystemEventDetail } from '../types'

function memberNames(members: SystemEventDetail['members']): string {
  if (!members || members.length === 0) return 'someone'
  const names = members
    .map((m) => (m.displayName ?? '').trim())
    .filter((n) => n.length > 0)
  if (names.length === 0) return 'someone'
  if (names.length === 1) return names[0]!
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names[0]}, ${names[1]} and ${names.length - 2} other(s)`
}

function initiatorName(detail: SystemEventDetail): string | null {
  const name = detail.initiator?.user?.displayName?.trim()
  return name && name.length > 0 ? name : null
}

function shortType(odataType: string | undefined): string {
  if (!odataType) return ''
  // "#microsoft.graph.chatRenamedEventMessageDetail" -> "chatRenamed"
  const tail = odataType.split('.').pop() ?? ''
  return tail.replace(/EventMessageDetail$/i, '')
}

/**
 * Render a system event row to a short string. Returns null when the
 * event subtype is unknown or its payload is missing the fields we'd
 * need to make the line useful - the caller is expected to drop the
 * message in that case.
 */
export function describeSystemEvent(message: ChatMessage): string | null {
  if (message.messageType !== 'systemEventMessage') return null
  const detail = message.eventDetail
  if (!detail) return null
  const subtype = shortType(detail['@odata.type'])
  switch (subtype) {
    case 'chatCreated':
    case 'channelAdded':
      return 'chat created'
    case 'membersAdded': {
      const who = memberNames(detail.members)
      const by = initiatorName(detail)
      return by ? `${by} added ${who}` : `${who} joined`
    }
    case 'membersDeleted':
    case 'membersRemoved': {
      const who = memberNames(detail.members)
      const by = initiatorName(detail)
      return by ? `${by} removed ${who}` : `${who} left`
    }
    case 'memberJoined':
      return `${initiatorName(detail) ?? 'someone'} joined`
    case 'memberLeft':
      return `${initiatorName(detail) ?? 'someone'} left`
    case 'chatRenamed':
    case 'channelRenamed': {
      const topic = (detail.topic ?? '').toString().trim()
      const by = initiatorName(detail)
      if (!topic) return null
      return by ? `${by} renamed the chat to "${topic}"` : `chat renamed to "${topic}"`
    }
    case 'topicUpdated': {
      const topic = (detail.topic ?? '').toString().trim()
      if (!topic) return null
      return `topic set to "${topic}"`
    }
    case 'callEnded':
    case 'callRecording':
    case 'callTranscript': {
      const kind = subtype === 'callEnded' ? 'Call' : subtype === 'callRecording' ? 'Recording' : 'Transcript'
      const duration = (detail.callDuration ?? '').toString().trim()
      return duration ? `${kind} ended (${formatIsoDuration(duration)})` : `${kind} ended`
    }
    case 'callStarted':
      return 'Call started'
    case 'meetingStarted':
      return 'Meeting started'
    case 'meetingEnded':
      return 'Meeting ended'
    case 'tabUpdated':
    case 'teamsAppInstalled':
    case 'teamsAppRemoved':
      return null
    default:
      return null
  }
}

// Graph callDuration arrives as ISO-8601 (PT1H2M3S). Render it as
// 1h 2m, 12m, or 45s for the events list. Falls back to the raw value
// if we can't parse it.
export function formatIsoDuration(iso: string): string {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso)
  if (!m) return iso
  const hours = m[1] ? Number(m[1]) : 0
  const minutes = m[2] ? Number(m[2]) : 0
  const seconds = m[3] ? Math.round(Number(m[3])) : 0
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  if (minutes > 0) return seconds > 0 && minutes < 5 ? `${minutes}m ${seconds}s` : `${minutes}m`
  return `${seconds}s`
}
