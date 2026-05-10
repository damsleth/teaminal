// Log file plumbing for e2e tests.
//
// The dev script writes to .tmp/events.log and .tmp/network.log. The
// e2e runner doesn't spawn a teaminal process - it imports modules
// directly - so we wire the running session's logger to those files
// just like bin/teaminal.tsx does. That way the same log surfaces are
// available to read after a test for diagnostics.

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { setLogFile, setNetworkLog } from '../src/log'

const TMP_DIR = join(process.cwd(), '.tmp')
export const EVENTS_LOG = join(TMP_DIR, 'events.log')
export const NETWORK_LOG = join(TMP_DIR, 'network.log')

let installed = false

export function installLogging(): void {
  if (installed) return
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true })
  setLogFile(EVENTS_LOG)
  setNetworkLog(NETWORK_LOG)
  installed = true
}

export function logFileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

export type LogTail = {
  /** Returns lines appended to the file since the tail was started. */
  readNew: () => Promise<string[]>
  /** Stops watching. Idempotent. */
  stop: () => void
}

export async function tailFromOffset(path: string, startOffset: number): Promise<string[]> {
  if (!existsSync(path)) return []
  const file = Bun.file(path)
  const size = file.size
  if (size <= startOffset) return []
  const stream = file.stream()
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
  }
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    buf.set(c, off)
    off += c.byteLength
  }
  const slice = buf.slice(startOffset)
  const text = new TextDecoder().decode(slice)
  return text.split(/\r?\n/).filter((l) => l.length > 0)
}
