// Size-capped response reading, shared by every binary download (Graph
// hosted contents and photos, asyncgw objects, external images).
//
// A declared Content-Length over the cap fails before any byte is read; a
// body without one is cut off as soon as it passes the cap, so an oversized
// download is never buffered whole.

export async function readBodyCapped(
  res: Response,
  maxBytes: number,
  tooLarge: () => Error,
): Promise<Uint8Array> {
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
    await reader.cancel()
    reader.releaseLock()
  }
}
