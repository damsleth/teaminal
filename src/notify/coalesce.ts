// Notification coalescing + global rate limit.
//
// Goals:
//   1. Don't fire 5 banners for 5 mentions in the same conv inside 30s.
//   2. Don't fire more than one banner every 5s globally, no matter how
//      many convs are pinging at once.
//
// Strategy:
//   - Per-conv state tracks lastFiredAt + a pending coalesce queue. The
//     first mention in a conv fires immediately (subject to the global
//     rate limit). Subsequent mentions in the same conv inside the
//     window are buffered into a single follow-up "(+N more) latest:
//     ..." banner that fires when the window expires (or at the end of
//     the cap).
//   - A single drain timer (1s) processes pending coalesces and the
//     global queue. Production code should call drain() on a timer; the
//     queue can also be drained synchronously by tests via drain(now).
//
// All time is injected so tests are fully deterministic.

import type { ConvKey } from '../state/store'

export const COALESCE_WINDOW_MS = 30_000
export const COALESCE_CAP_MS = 90_000
export const RATE_LIMIT_MS = 5_000
export const DIGEST_AGE_MS = 30_000

export type Banner = {
  conv: ConvKey
  title: string
  body: string
}

export type EnqueueInput = {
  conv: ConvKey
  title: string
  body: string
  senderName: string
  preview: string
}

type ConvState = {
  conv: ConvKey
  // Wall-clock of the most recently fired banner for this conv.
  lastFiredAt: number
  // Wall-clock of the very first event in the current coalesce window.
  windowStartedAt: number
  // Buffered events since the last fire; emitted as a digest banner when
  // the window expires.
  buffered: EnqueueInput[]
  // Most recent event seen, used to render "+N more" digests.
  latest: EnqueueInput
}

export type Notifier = (banner: Banner) => void

export type CoalescerOpts = {
  notify: Notifier
  // Override defaults for tests.
  coalesceWindowMs?: number
  coalesceCapMs?: number
  rateLimitMs?: number
  digestAgeMs?: number
}

export type Coalescer = {
  /**
   * Add a new mention. Fires its banner immediately when allowed by the
   * coalesce + rate-limit rules; otherwise buffers it for a digest.
   */
  enqueue(input: EnqueueInput, now: number): void
  /**
   * Process pending banners against `now`. Production wiring calls this
   * on a 1s setInterval; tests call it directly with a chosen clock.
   */
  drain(now: number): void
  /** Internal state inspector for tests. */
  __peek(): { lastGlobalFiredAt: number; convStates: Map<ConvKey, ConvState> }
}

export function makeCoalescer(opts: CoalescerOpts): Coalescer {
  const window = opts.coalesceWindowMs ?? COALESCE_WINDOW_MS
  const cap = opts.coalesceCapMs ?? COALESCE_CAP_MS
  const rateLimit = opts.rateLimitMs ?? RATE_LIMIT_MS
  // Note: digest age is unused for now; reserved for the "queue older
  // than 30s collapses into a single banner" path the plan describes.
  void (opts.digestAgeMs ?? DIGEST_AGE_MS)
  const states = new Map<ConvKey, ConvState>()
  let lastGlobalFiredAt = Number.NEGATIVE_INFINITY

  function fire(banner: Banner, now: number): void {
    lastGlobalFiredAt = now
    opts.notify(banner)
  }

  function ratedAllowed(now: number): boolean {
    return now - lastGlobalFiredAt >= rateLimit
  }

  function flushConv(s: ConvState, now: number): void {
    if (s.buffered.length === 0) return
    const count = s.buffered.length
    const senders = uniqueSenders(s.buffered)
    const senderLabel =
      senders.length === 1 ? senders[0]! : `${senders[0]} (+${senders.length - 1})`
    const preview = s.latest.preview
    const banner: Banner = {
      conv: s.conv,
      title: s.latest.title,
      body: `${senderLabel}: ${preview}${count > 1 ? `  (+${count} more)` : ''}`,
    }
    s.buffered = []
    s.lastFiredAt = now
    fire(banner, now)
  }

  function enqueue(input: EnqueueInput, now: number): void {
    let s = states.get(input.conv)
    if (!s) {
      // Brand-new conv: fire immediately if rate-limit allows; otherwise
      // buffer with windowStartedAt = now so the drain timer picks it up.
      s = {
        conv: input.conv,
        lastFiredAt: 0,
        windowStartedAt: now,
        buffered: [],
        latest: input,
      }
      states.set(input.conv, s)
      if (ratedAllowed(now)) {
        s.lastFiredAt = now
        fire(
          { conv: input.conv, title: input.title, body: `${input.senderName}: ${input.preview}` },
          now,
        )
      } else {
        s.buffered.push(input)
      }
      return
    }
    s.latest = input
    const windowOpen = now - s.lastFiredAt < window
    if (!windowOpen && s.buffered.length === 0) {
      // The previous coalesce window has fully closed; treat this as a
      // fresh first-mention for this conv.
      s.windowStartedAt = now
      if (ratedAllowed(now)) {
        s.lastFiredAt = now
        fire(
          { conv: input.conv, title: input.title, body: `${input.senderName}: ${input.preview}` },
          now,
        )
      } else {
        s.buffered.push(input)
      }
      return
    }
    // Inside an active coalesce window, or rate-limited follow-up:
    // buffer for the digest.
    s.buffered.push(input)
    const inCap = now - s.windowStartedAt < cap
    if (!inCap) {
      // Cap exceeded; force-flush even if window hasn't expired.
      flushConv(s, now)
      s.windowStartedAt = now
    }
  }

  function drain(now: number): void {
    for (const s of states.values()) {
      if (s.buffered.length === 0) continue
      const windowExpired = now - s.windowStartedAt >= window
      const capExpired = now - s.windowStartedAt >= cap
      if (windowExpired || capExpired) {
        if (ratedAllowed(now)) {
          flushConv(s, now)
          s.windowStartedAt = now
        }
        // If rate-limited, leave buffered; next drain tick retries.
      }
    }
  }

  return {
    enqueue,
    drain,
    __peek: () => ({
      lastGlobalFiredAt: lastGlobalFiredAt === Number.NEGATIVE_INFINITY ? 0 : lastGlobalFiredAt,
      convStates: states,
    }),
  }
}

function uniqueSenders(items: EnqueueInput[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const it of items) {
    if (seen.has(it.senderName)) continue
    seen.add(it.senderName)
    out.push(it.senderName)
  }
  return out
}
