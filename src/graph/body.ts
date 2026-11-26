// Size-capped response reading, shared by every binary download (Graph
// hosted contents and photos, asyncgw objects, external images).
//
// A declared Content-Length over the cap fails before any byte is read; a
// body without one is cut off as soon as it passes the cap, so an oversized
// download is never buffered whole.

// Over the cap. Its own type so a caller with a fallback route (asyncgw <->
// Graph) can tell "too big" from "this route failed" and not try the other.
export class ResponseTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResponseTooLargeError'
  }
}

export async function readBodyCapped(
  res: Response,
  maxBytes: number,
  message: string,
): Promise<Uint8Array> {
  const tooLarge = () => new ResponseTooLargeError(message)
  if (Number(res.headers.get('content-length')) > maxBytes) {
    await res.body?.cancel()
    throw tooLarge()
  }
  const reader = res.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw tooLarge()
      chunks.push(value)
    }
    return Buffer.concat(chunks, size)
  } finally {
    // A stream that already errored rejects cancel too; still release.
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
