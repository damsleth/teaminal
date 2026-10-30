// One-shot presence actions: set or clear the user's status message.
// UI calls these; they wrap the Teams presence service (see
// src/graph/teamsPresence.ts) and mirror the result into the store so the
// UI doesn't wait for the next presence poll.

import { owaProfile } from '../account'
import { publishMyNote } from '../graph/teamsPresence'
import type { Presence } from '../types'
import type { AccountStore } from './accountStore'

// Parse the "ends" field of the status dialog. Empty = never. Accepts a
// duration ("30m", "2h", "1d"), "today" (end of day), "tomorrow" (end of
// tomorrow), "HH:MM" (next occurrence) or "YYYY-MM-DD[ HH:MM]". Returns
// null for input it cannot read, undefined for "never expires".
export function parseStatusEnd(input: string, now: Date = new Date()): Date | null | undefined {
  const t = input.trim().toLowerCase()
  if (!t || t === 'never') return undefined
  const dur = /^(\d+)\s*(m|h|d)$/.exec(t)
  if (dur) {
    const unit = { m: 60e3, h: 3600e3, d: 86400e3 }[dur[2] as 'm' | 'h' | 'd']
    return new Date(now.getTime() + Number(dur[1]) * unit)
  }
  const endOfDay = (offsetDays: number) => {
    const d = new Date(now)
    d.setDate(d.getDate() + offsetDays)
    d.setHours(23, 59, 0, 0)
    return d
  }
  if (t === 'today') return endOfDay(0)
  if (t === 'tomorrow') return endOfDay(1)
  const hm = /^(\d{1,2}):(\d{2})$/.exec(t)
  if (hm) {
    const d = new Date(now)
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0)
    if (Number(hm[1]) > 23 || Number(hm[2]) > 59) return null
    if (d <= now) d.setDate(d.getDate() + 1)
    return d
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{1,2}):(\d{2}))?$/.exec(t)
  if (date) {
    const d = new Date(
      Number(date[1]),
      Number(date[2]) - 1,
      Number(date[3]),
      date[4] ? Number(date[4]) : 23,
      date[5] ? Number(date[5]) : 59,
    )
    return Number.isNaN(d.getTime()) || d <= now ? null : d
  }
  return null
}

// Publish `message` (empty clears) and reflect it in myPresence.
export async function setStatusNote(
  acc: AccountStore,
  message: string,
  expiry: Date | null,
  signal?: AbortSignal,
): Promise<void> {
  const text = message.trim()
  await publishMyNote(text, expiry, { profile: owaProfile(acc.ref), signal })
  acc.set((s) => {
    const cur: Presence = s.myPresence ?? {
      id: s.me?.id ?? '',
      availability: 'PresenceUnknown',
      activity: 'PresenceUnknown',
    }
    return {
      myPresence: {
        ...cur,
        note: text ? { message: text, expiry: expiry?.toISOString() } : undefined,
      },
    }
  })
}
