// Kitty keyboard protocol detection.
//
// The protocol is what tells Ctrl+Enter (send) apart from Enter (newline)
// in the composer. Rather than a terminal-name allow list, ask the terminal:
// `CSI ? u` (kitty flags query) followed by `CSI c` (primary device
// attributes). A terminal that speaks the protocol answers the flags query
// before DA1; nearly every terminal answers DA1, so an unsupporting one ends
// the probe as soon as that reply lands. The timeout only covers terminals
// that answer neither.
//
// Same pre-Ink rules as probeCellAspect / probeTextSizing: run before Ink
// owns stdin, and never pause stdin from inside its own 'data' handler
// (AGENTS.md pitfall 10) — finish via setImmediate.
// ponytail: a reply slower than the timeout (e.g. over a laggy ssh link)
// lands in Ink as stray input; the probe only reports "unsupported" then.

let enabled = false

// Whether teaminal turned the protocol on (bin/teaminal.tsx sets this from
// the probe). Anything that hands the terminal to another program (the
// $VISUAL editor) pops and re-pushes the mode only when this is true.
export function kittyKeyboardEnabled(): boolean {
  return enabled
}

export function setKittyKeyboardEnabled(on: boolean): void {
  enabled = on
}

// true: flags reply seen (supported). false: DA1 seen without one. null:
// neither yet.
export function parseKittyKeyboardProbe(acc: string): boolean | null {
  if (/\x1b\[\?\d+u/.test(acc)) return true
  if (/\x1b\[\?[\d;]*c/.test(acc)) return false
  return null
}

export async function probeKittyKeyboard(timeoutMs = 60): Promise<boolean> {
  const { stdin, stdout } = process
  if (!stdin.isTTY || !stdout.isTTY) return false
  const wasRaw = stdin.isRaw
  let done = false
  return new Promise<boolean>((resolve) => {
    let acc = ''
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      stdin.off('data', onData)
      stdin.pause()
      if (!wasRaw) stdin.setRawMode(false)
      resolve(ok)
    }
    const onData = (chunk: Buffer): void => {
      acc += chunk.toString('binary')
      const ok = parseKittyKeyboardProbe(acc)
      // Finish outside the 'data' callback: Bun never emits 'readable' again
      // for a stdin paused from inside its own 'data' handler, so Ink would
      // attach its reader to a dead stream and every key (Ctrl-C too) is lost.
      // On `true`, keep reading until DA1 so its reply isn't left for Ink.
      if (ok === false || (ok && /\x1b\[\?[\d;]*c/.test(acc))) setImmediate(() => finish(ok))
    }
    const timer = setTimeout(() => finish(parseKittyKeyboardProbe(acc) === true), timeoutMs)
    try {
      stdin.setRawMode(true)
      stdin.resume()
      stdin.on('data', onData)
      stdout.write('\x1b[?u\x1b[c')
    } catch {
      finish(false)
    }
  })
}
