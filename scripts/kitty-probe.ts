// Diagnostic: what does this terminal actually do with our image placements?
//
// Run it IN the terminal you use teaminal in (it needs /dev/tty):
//   bun run scripts/kitty-probe.ts
//
// Everything teaminal emits carries q=2, which suppresses the terminal's
// OK/ERROR replies - great in production, useless for diagnosis. This asks
// the same questions with q=0 and prints what comes back, so a placement
// that silently draws nothing is visible.

import { openSync, readFileSync, readSync, writeSync, closeSync } from 'node:fs'
import { ReadStream } from 'node:tty'

const Z = 17_042 // TEAMINAL_KITTY_Z
const ID = 9042

const fd = openSync('/dev/tty', 'r+')
const tty = new ReadStream(fd)
tty.setRawMode(true)

const write = (s: string): void => void writeSync(fd, s)

function drain(until: RegExp, timeoutMs = 1200): string | null {
  const buf = Buffer.alloc(1024)
  let acc = ''
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let n = 0
    try {
      n = readSync(fd, buf, 0, buf.length, null)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EAGAIN') continue
      throw err
    }
    if (n > 0) {
      acc += buf.subarray(0, n).toString('binary')
      if (until.test(acc)) return acc
    }
  }
  return acc || null
}

// A graphics reply looks like ESC _ G i=<id>;OK ESC \ (or ;ENOENT:... etc).
function graphicsReply(escape: string): string {
  write(escape)
  const raw = drain(/\x1b_G[^\x1b]*\x1b\\/)
  const m = raw?.match(/\x1b_G([^\x1b]*)\x1b\\/)
  return m ? m[1]! : 'no reply'
}

const png =
  process.argv[2] ??
  `${process.env.HOME}/.cache/teaminal/swon/images/7e6a77ed00568c8ebbf10817e4e5e65ca3c1c063.bin`
const data = readFileSync(png)
const b64 = data.toString('base64')

// Production's transmit, with q=0 so the terminal answers.
function transmit(rows: number): string {
  const CHUNK = 4096
  const chunks: string[] = []
  for (let i = 0; i < b64.length; i += CHUNK) chunks.push(b64.slice(i, i + CHUNK))
  const head = `a=T,f=100,i=${ID},r=${rows},C=1,z=${Z},q=0`
  if (chunks.length === 1) return `\x1b_G${head},m=0;${chunks[0]}\x1b\\`
  const parts = [`\x1b_G${head},m=1;${chunks[0]}\x1b\\`]
  for (let i = 1; i < chunks.length - 1; i++) parts.push(`\x1b_Gm=1;${chunks[i]}\x1b\\`)
  parts.push(`\x1b_Gm=0;${chunks[chunks.length - 1]}\x1b\\`)
  return parts.join('')
}

const place = (rows: number) => `\x1b_Ga=p,i=${ID},r=${rows},C=1,z=${Z},q=0\x1b\\`
const clearPlacements = `\x1b_Ga=d,d=z,z=${Z},q=0\x1b\\` // exactly what clearKittyImages sends

const out: string[] = []
write('\x1b[2J\x1b[H')

out.push(`1. transmit (a=T)                 -> ${graphicsReply(transmit(10))}`)
out.push(`2. place by id, no delete (a=p)   -> ${graphicsReply(place(10))}`)
out.push(`3. clearKittyImages (a=d,d=z,z=)  -> ${graphicsReply(clearPlacements)}`)
out.push(`4. place by id after that clear   -> ${graphicsReply(place(10))}`)
out.push(`5. place by id, different rows    -> ${graphicsReply(place(6))}`)

write(`\x1b_Ga=d,d=A,q=2\x1b\\`)
write('\x1b[2J\x1b[H')
tty.setRawMode(false)
write(out.join('\r\n') + '\r\n')
closeSync(fd)
