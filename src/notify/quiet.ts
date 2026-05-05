// Quiet predicates: when should a banner be suppressed?
//
// Returns 'silent' (no bell, no banner), 'bell-only' (terminal beep,
// suppress system banner), or 'normal' (both). The bell is intentionally
// the harder thing to suppress because the user can mute their terminal
// emulator independently and we don't want to swallow audible cues for
// a settings combination they might not have realized they enabled.

import type { AppState, ConvKey } from '../state/store'

export type QuietDecision = 'silent' | 'bell-only' | 'normal'

export type QuietContext = {
  // Conversation receiving the notification.
  conv: ConvKey
  // Wall-clock time of the decision; injected so tests are deterministic.
  now: Date
  // Snapshot of the relevant store state.
  state: Pick<AppState, 'focus' | 'myPresence' | 'settings'>
  // Whether the terminal currently has OS focus. teaminal already tracks
  // this; we suppress banners (but keep the bell) when the user is
  // already at the terminal.
  terminalFocused: boolean
}

/**
 * Parses 'HH:MM' into minutes-since-midnight. Returns null on malformed
 * input so the caller can treat 'no quiet hours' as the default.
 */
export function parseClock(s: string | undefined | null): number | null {
  if (!s) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) return null
  const hh = Number(m[1])
  const mm = Number(m[2])
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null
  return hh * 60 + mm
}

/**
 * True when `now`'s hour:minute falls inside [start, end). Wraps over
 * midnight when start > end (e.g. 22:00 -> 07:30).
 */
export function isWithinQuietHours(now: Date, startHHMM: string, endHHMM: string): boolean {
  const start = parseClock(startHHMM)
  const end = parseClock(endHHMM)
  if (start === null || end === null) return false
  const t = now.getHours() * 60 + now.getMinutes()
  if (start === end) return false
  if (start < end) return t >= start && t < end
  // Wraps midnight.
  return t >= start || t < end
}

export function decideQuiet(ctx: QuietContext): QuietDecision {
  const { state, conv, now, terminalFocused } = ctx
  const settings = state.settings as Record<string, unknown>

  // Manual mute kills banners; bell still rings (terminal level).
  if (settings.notifyMuted === true) return 'bell-only'

  // Active conversation: bell is informative, the banner is noise.
  // Configurable so the user can opt back in.
  const focusKeyValue = focusToKey(state.focus)
  if (focusKeyValue === conv && terminalFocused) {
    if (settings.notifyActiveBanner === true) return 'normal'
    if (settings.notifyActiveBell === false) return 'silent'
    return 'bell-only'
  }

  // Presenting / DnD: drop banners; bell stays. The user is on a call
  // or has explicitly told their org client they don't want disruption.
  const activity = state.myPresence?.activity
  if (activity === 'Presenting' || activity === 'DoNotDisturb') {
    return 'bell-only'
  }

  // Quiet hours: drop banners during the configured window.
  const start = settings.quietHoursStart
  const end = settings.quietHoursEnd
  if (typeof start === 'string' && typeof end === 'string') {
    if (isWithinQuietHours(now, start, end)) return 'bell-only'
  }

  return 'normal'
}

// Local copy of focusKey so this module doesn't pull in the full store
// surface just for one helper.
function focusToKey(focus: AppState['focus']): ConvKey | null {
  if (focus.kind === 'chat') return `chat:${focus.chatId}`
  if (focus.kind === 'channel') return `channel:${focus.teamId}:${focus.channelId}`
  return null
}
