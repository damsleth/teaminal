// Terminal background detection for the 'auto' theme.
//
// `auto` is not a theme: it picks the built-in light or dark theme to match
// the terminal. Ask the terminal for its background color with OSC 11
// (`ESC ] 11 ; ? ST`), followed by DA1 (`CSI c`) so a terminal that ignores
// OSC 11 ends the probe as soon as its DA1 reply lands. A light background
// (relative luminance above one half) picks light, anything else dark.
//
// Same pre-Ink rules as probeKittyKeyboard: run before Ink owns stdin, and
// never pause stdin from inside its own 'data' handler (AGENTS.md pitfall
// 10) — finish via setImmediate.

import type { SystemAppearance } from '../state/store'

// 'light' / 'dark' from an OSC 11 reply in `acc`; undefined when DA1 came
// back without one (no answer coming), null when neither has arrived yet.
export function parseBackgroundProbe(acc: string): SystemAppearance | null | undefined {
  const m = /\x1b\]11;rgba?:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i.exec(acc)
  if (m) return appearanceOf(m.slice(1, 4) as [string, string, string])
  if (/\x1b\[\?[\d;]*c/.test(acc)) return undefined
  return null
}

// Each channel is 1-4 hex digits scaled to its own maximum (rgb:ff/ff/ff and
// rgb:ffff/ffff/ffff both mean white).
function appearanceOf(channels: [string, string, string]): SystemAppearance {
  const [r, g, b] = channels.map((h) => {
    const c = parseInt(h, 16) / (16 ** h.length - 1)
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? 'light' : 'dark'
}

// The terminal's appearance, or null when it doesn't report a background.
export async function probeTerminalBackground(timeoutMs = 80): Promise<SystemAppearance | null> {
  const { stdin, stdout } = process
  if (!stdin.isTTY || !stdout.isTTY) return null
  const wasRaw = stdin.isRaw
  let done = false
  return new Promise<SystemAppearance | null>((resolve) => {
    let acc = ''
    const finish = (result: SystemAppearance | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      stdin.off('data', onData)
      stdin.pause()
      if (!wasRaw) stdin.setRawMode(false)
      resolve(result)
    }
    const onData = (chunk: Buffer): void => {
      acc += chunk.toString('binary')
      const parsed = parseBackgroundProbe(acc)
      // Finish outside the 'data' callback (pitfall 10). On an answer, keep
      // reading until DA1 so its reply isn't left for Ink.
      if (parsed === undefined) setImmediate(() => finish(null))
      else if (parsed && /\x1b\[\?[\d;]*c/.test(acc)) setImmediate(() => finish(parsed))
    }
    const timer = setTimeout(() => finish(parseBackgroundProbe(acc) ?? null), timeoutMs)
    try {
      stdin.setRawMode(true)
      stdin.resume()
      stdin.on('data', onData)
      stdout.write('\x1b]11;?\x1b\\\x1b[c')
    } catch {
      finish(null)
    }
  })
}
