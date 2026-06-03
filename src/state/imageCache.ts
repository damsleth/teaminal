// Disk-backed cache for image blobs from Teams message attachments.
//
// Cache directory: ${XDG_CACHE_HOME:-~/.cache}/teaminal/<safe-profile>/images/
// Each entry is two files: <sha1-of-key>.bin (blob) + <sha1-of-key>.meta.json
// The cache key is messageId::attachmentId - never contains signed URLs or
// other credentials. Blobs are rejected above MAX_IMAGE_BYTES to bound disk use.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getAudiencePreference, graphBinary, GraphError } from '../graph/client'
import { fetchObjectById, fetchObjectByUrl, isAsyncGwUrl } from '../graph/teamsAsyncGw'
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
  return join(base, 'teaminal', safeProfileSegment(profile), 'images')
}

/** Absolute path to a profile's on-disk image cache directory. */
export function getImageCacheDir(profile?: string | null): string {
  return getCacheDir(profile ?? undefined)
}

// Remove a profile's on-disk image blobs and drop the in-memory fetch
// status / blob maps so the next render re-fetches from the network.
// Best-effort: a missing directory is a no-op. Returns the directory it
// targeted so callers can log it.
export function clearImageCache(profile?: string | null): string {
  const dir = getCacheDir(profile ?? undefined)
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort
  }
  fetchStatus.clear()
  imageDataCache.clear()
  return dir
}

function safeProfileSegment(profile?: string): string {
  const raw = profile && profile.length > 0 ? profile : 'default'
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_')
  return safe.length > 0 ? safe : 'default'
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
  // When true, fetch directly with plain fetch() and no Authorization
  // header. Used for giphy/tenor URLs returned by the Teams gif picker;
  // sending a Bearer token to those hosts produces a rejection.
  isExternal?: boolean
  // Raw asm/asyncgw object id, when known. Lets ic3 (Conditional-Access)
  // accounts retrieve the image via asyncgw instead of the Graph
  // hostedContents endpoint, which 401s under the CA gate.
  objectId?: string
  // AsyncGW region (`emea`, `amer`, `apac`, `ind`) when known from the
  // original asm/asyncgw object URL.
  region?: string
}

// Whether `path` is something graphBinary can actually fetch (a Graph-relative
// path or absolute Graph URL) — as opposed to an asm object URL or the empty
// path we leave on chatsvc-sourced messages.
function isGraphFetchable(path: string): boolean {
  return path.startsWith('/') || path.startsWith('https://graph.microsoft.com/')
}

// Fetch a hosted-content image, routing between the Graph hostedContents
// endpoint and the asyncgw object store per the account's routing mode
// (getAudiencePreference). ic3 accounts go to asyncgw (the Graph endpoint is
// CA-gated); graph accounts use Graph and fall back to asyncgw when the
// object id is known: on 401 when audience fallback is enabled, and on 404
// always — cross-tenant 1:1 chats home the hosted content in the other
// tenant, so our tenant's Graph 404s while the asyncgw object store serves
// it (chat membership is in the object ACL).
async function fetchHostedContent(path: string, opts?: FetchImageOpts): Promise<Uint8Array> {
  const { audience, fallback } = getAudiencePreference()
  const objectId = opts?.objectId
  const viaGraph = (): Promise<Uint8Array> =>
    graphBinary({ method: 'GET', path, signal: opts?.signal })
  const viaAsyncGw = async (): Promise<Uint8Array> => {
    const { bytes } = await fetchObjectById(objectId!, {
      profile: opts?.profile,
      region: opts?.region,
      signal: opts?.signal,
    })
    return bytes
  }
  const canGraph = isGraphFetchable(path)

  if (audience === 'ic3' && objectId) {
    if (!fallback || !canGraph) return viaAsyncGw()
    try {
      return await viaAsyncGw()
    } catch {
      return viaGraph()
    }
  }
  if (canGraph) {
    try {
      return await viaGraph()
    } catch (err) {
      if (objectId && err instanceof GraphError) {
        // 401: CA-gated account — only when audience fallback is opted in.
        // 404: cross-tenant hosted content Graph can't serve — always try.
        if ((fallback && err.status === 401) || err.status === 404) {
          return viaAsyncGw()
        }
      }
      throw err
    }
  }
  // No Graph path (e.g. an asm object URL, or a chatsvc message with no chat
  // id) — asyncgw is the only route.
  if (objectId) return viaAsyncGw()
  throw new Error('image has no Graph path and no asyncgw object id')
}

// Fetch an image blob from Graph and cache it on disk. Returns null on
// oversized or failed downloads; the caller falls back to text display.
// The path must already be a Graph-relative path, absolute Graph URL, or
// (when opts.isExternal is true) an absolute https URL for a third-party
// host. Never a raw signed URL with embedded credentials.
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
    if (opts?.isExternal && isAsyncGwUrl(path)) {
      // AsyncGW URLs aren't really "external" — they need a session
      // cookie obtained from aadtokenauth. Route them through the
      // asyncgw client which mints/refreshes the cookie as needed.
      const fetched = await fetchObjectByUrl(path, {
        profile: opts.profile,
        signal: opts.signal,
      })
      bytes = fetched.bytes
    } else if (opts?.isExternal) {
      bytes = await fetchExternalImage(path, opts?.signal)
    } else {
      bytes = await fetchHostedContent(path, opts)
    }
  } catch (err) {
    recordEvent(
      'graph',
      'warn',
      `image fetch failed for ${meta.name}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }

  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    recordEvent(
      'graph',
      'warn',
      `image too large (${bytes.byteLength} bytes), skipping: ${meta.name}`,
    )
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

// Fetch an arbitrary image URL without auth headers. Applies the same
// size cap as the Graph path. Used by the gif-picker shape, where
// contentUrl is an external CDN URL (giphy/tenor) that rejects Bearer
// tokens.
async function fetchExternalImage(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const res = await fetch(url, { signal })
  if (!res.ok) {
    throw new Error(`external image fetch ${res.status} ${res.statusText}`)
  }
  const ab = await res.arrayBuffer()
  return new Uint8Array(ab)
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
