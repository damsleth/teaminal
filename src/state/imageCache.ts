// Disk-backed cache for image blobs from Teams message attachments.
//
// Cache directory: ${XDG_CACHE_HOME:-~/.cache}/teaminal/<profile>/images/
// Each entry is two files: <sha1-of-key>.bin (blob) + <sha1-of-key>.meta.json
// The cache key is messageId::attachmentId - never contains signed URLs or
// other credentials. Blobs are rejected above MAX_IMAGE_BYTES to bound disk use.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { graphBinary } from '../graph/client'
import { recordEvent } from '../log'

const MAX_IMAGE_BYTES = 4 * 1024 * 1024

export type ImageMeta = {
  contentType: string
  name: string
  size: number
}

export type CachedImage = {
  data: Buffer
  meta: ImageMeta
}

export function imageCacheKey(messageId: string, attachmentId: string): string {
  return `${messageId}::${attachmentId}`
}

function getCacheDir(profile?: string): string {
  const xdg = process.env.XDG_CACHE_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.cache')
  return join(base, 'teaminal', profile ?? 'default', 'images')
}

function blobPath(key: string, profile?: string): string {
  const hash = createHash('sha1').update(key).digest('hex')
  return join(getCacheDir(profile), `${hash}.bin`)
}

function metaPath(key: string, profile?: string): string {
  const hash = createHash('sha1').update(key).digest('hex')
  return join(getCacheDir(profile), `${hash}.meta.json`)
}

export function readCachedImage(key: string, profile?: string): CachedImage | null {
  const bp = blobPath(key, profile)
  const mp = metaPath(key, profile)
  if (!existsSync(bp) || !existsSync(mp)) return null
  try {
    const data = Buffer.from(readFileSync(bp))
    const meta = JSON.parse(readFileSync(mp, 'utf8')) as ImageMeta
    return { data, meta }
  } catch {
    return null
  }
}

function writeCachedImage(key: string, data: Buffer, meta: ImageMeta, profile?: string): void {
  const dir = getCacheDir(profile)
  mkdirSync(dir, { recursive: true })
  writeFileSync(blobPath(key, profile), data)
  writeFileSync(metaPath(key, profile), JSON.stringify(meta))
}

export type FetchImageOpts = {
  profile?: string
  signal?: AbortSignal
}

// Fetch an image blob from Graph and cache it on disk. Returns null on
// oversized or failed downloads; the caller falls back to text display.
// The path must already be a Graph-relative path or absolute Graph URL -
// never a raw signed URL with embedded credentials.
export async function fetchAndCacheImage(
  path: string,
  key: string,
  meta: { contentType: string; name: string },
  opts?: FetchImageOpts,
): Promise<Buffer | null> {
  const cached = readCachedImage(key, opts?.profile)
  if (cached) return cached.data

  let bytes: Uint8Array
  try {
    bytes = await graphBinary({ method: 'GET', path, signal: opts?.signal })
  } catch (err) {
    recordEvent(
      'graph',
      'warn',
      `image fetch failed for ${meta.name}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }

  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    recordEvent('graph', 'warn', `image too large (${bytes.byteLength} bytes), skipping: ${meta.name}`)
    return null
  }

  const buf = Buffer.from(bytes)
  writeCachedImage(key, buf, { ...meta, size: bytes.byteLength }, opts?.profile)
  return buf
}

// In-memory status for images currently visible in the message pane.
// Avoids re-fetching on every render cycle.
type FetchStatus = 'pending' | 'loading' | 'ready' | 'error'

const fetchStatus = new Map<string, FetchStatus>()
const imageDataCache = new Map<string, Buffer>()

export function getImageStatus(key: string): FetchStatus {
  return fetchStatus.get(key) ?? 'pending'
}

export function getImageData(key: string): Buffer | undefined {
  return imageDataCache.get(key)
}

// Trigger an async fetch for a key. Calls onChange when the status
// transitions so callers can schedule a re-render. Safe to call
// repeatedly - subsequent calls while loading are no-ops.
export function ensureImageFetched(
  path: string,
  key: string,
  meta: { contentType: string; name: string },
  opts: FetchImageOpts & { onChange: () => void },
): void {
  const current = fetchStatus.get(key)
  if (current === 'loading' || current === 'ready' || current === 'error') return

  const disk = readCachedImage(key, opts.profile)
  if (disk) {
    fetchStatus.set(key, 'ready')
    imageDataCache.set(key, disk.data)
    return
  }

  fetchStatus.set(key, 'loading')
  fetchAndCacheImage(path, key, meta, opts)
    .then((buf) => {
      if (buf) {
        imageDataCache.set(key, buf)
        fetchStatus.set(key, 'ready')
      } else {
        fetchStatus.set(key, 'error')
      }
      opts.onChange()
    })
    .catch(() => {
      fetchStatus.set(key, 'error')
      opts.onChange()
    })
}
