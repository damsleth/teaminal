// Public notification entry point.
//
// notifyMention is the only function call sites should reach for. It
// applies the quiet-hours / focus / DnD / mute predicates, then delegates
// to the coalescer, which decides whether to fire immediately, buffer
// for a digest, or hold for the global rate limit.
//
// One process-wide coalescer is created lazily on the first call. The
// drain timer is the caller's responsibility (bin/teaminal.tsx wires
// a 1s setInterval); for tests, drain() can be invoked directly.

import { recordEvent } from '../log'
import type { AppState, ConvKey } from '../state/store'
import { makeCoalescer, type Banner, type Coalescer } from './coalesce'
import { ringBell, postBanner } from './notify'
import { decideQuiet, type QuietContext } from './quiet'

export type NotifyMentionInput = {
  conv: ConvKey
  senderName: string
  preview: string
  // 'chat' or 'channel-name'.
  scope: string
}

export type NotifyContext = Pick<QuietContext, 'state' | 'now' | 'terminalFocused'>

let coalescer: Coalescer | null = null

function getCoalescer(): Coalescer {
  if (coalescer) return coalescer
  coalescer = makeCoalescer({
    notify: (banner: Banner) => {
      void postBanner(banner.title, banner.body).catch(() => {})
    },
  })
  return coalescer
}

/**
 * Notify the user of a mention. May fire immediately, buffer for a
 * digest, suppress to bell-only, or stay silent depending on the
 * quiet predicates. Always returns synchronously; system banner
 * dispatch is fire-and-forget.
 */
export function notifyMention(input: NotifyMentionInput, ctx: NotifyContext): void {
  const decision = decideQuiet({
    conv: input.conv,
    now: ctx.now,
    state: ctx.state,
    terminalFocused: ctx.terminalFocused,
  })
  if (decision !== 'silent') ringBell()
  recordEvent('notify', 'info', `mention ${decision}`, {
    conv: input.conv,
    sender: input.senderName,
  })
  if (decision !== 'normal') return

  const title = input.scope.startsWith('channel:')
    ? `teaminal \u00b7 #${input.scope.slice('channel:'.length)}`
    : `teaminal \u00b7 ${input.scope}`
  getCoalescer().enqueue(
    {
      conv: input.conv,
      title,
      body: `${input.senderName}: ${input.preview}`,
      senderName: input.senderName,
      preview: input.preview,
    },
    ctx.now.getTime(),
  )
}

/**
 * Drain the coalesce queue. bin/teaminal.tsx calls this on a 1s
 * setInterval; tests can call it directly with an injected clock.
 */
export function drainNotifications(now: number = Date.now()): void {
  getCoalescer().drain(now)
}

/** Test-only: replace the singleton coalescer. */
export function __setCoalescerForTests(c: Coalescer | null): void {
  coalescer = c
}

// Re-exports so call sites can import everything notify-related from
// one module.
export type { Banner } from './coalesce'
export type { QuietDecision } from './quiet'
export { decideQuiet } from './quiet'
export type AppStateForNotify = Pick<AppState, 'focus' | 'myPresence' | 'settings'>
