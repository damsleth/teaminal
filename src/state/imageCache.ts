// Disk-backed cache for image blobs from Teams message attachments.
//
// Cache directory: ${XDG_CACHE_HOME:-~/.cache}/teaminal/<profile-slug|default>/images/
// Each entry is two files: <sha1-of-key>.bin (blob) + <sha1-of-key>.meta.json
// The cache key is messageId::attachmentId - never contains signed URLs or
// other credentials. Blobs are rejected above MAX_IMAGE_BYTES to bound disk use.

import { lookup } from 'node:dns'
import { request } from 'node:https'
import { Readable } from 'node:stream'
import { BlockList, isIP } from 'node:net'
import { sendWithBackoff } from '../graph/backoff'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { teaminalCacheDir } from './cacheFiles'
import { accountRef, owaProfile, profileSlug, type AccountId } from '../account'
import { GraphError, type GraphClient } from '../graph/client'
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

// In-memory (and kitty) key for an image owned by one account. Two accounts
// can carry the same messageId::attachmentId with different bytes, so the
// memory maps and terminal-side ids are keyed by owner. The disk key stays
// the bare cacheKey: each account already has its own cache directory.
export function ownedImageKey(account: AccountId, cacheKey: string): string {
  return `${account}\u0000${cacheKey}`
}

// The parts of an ownedImageKey, or null for a bare key.
export function splitOwnedImageKey(owned: string): { account: AccountId; key: string } | null {
  const at = owned.indexOf('\u0000')
  return at < 0 ? null : { account: owned.slice(0, at) as AccountId, key: owned.slice(at + 1) }
}

function getCacheDir(profile?: string): string {
  const slug = profileSlug(accountRef(profile)) ?? 'default'
  return join(teaminalCacheDir(), slug, 'images')
}

/** Absolute path to a profile's on-disk image cache directory. */
export function getImageCacheDir(profile?: string | null): string {
  return getCacheDir(profile ?? undefined)
}

// Remove a profile's on-disk image blobs and drop its in-memory fetch
// status / blobs so the next render re-fetches from the network. Other
// accounts' entries stay.
// Best-effort: a missing directory is a no-op. Returns the directory it
// targeted so callers can log it.
// Bumped when a cache is cleared, so panes showing images fetch again.
let cacheGeneration = 0
export function imageCacheGeneration(): number {
  return cacheGeneration
}

export function clearImageCache(profile?: string | null): string {
  cacheGeneration++
  const dir = getCacheDir(profile ?? undefined)
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort
  }
  const prefix = ownedImageKey(accountRef(profile).id, '')
  for (const k of fetchStatus.keys()) if (k.startsWith(prefix)) fetchStatus.delete(k)
  for (const k of imageDataCache.keys()) if (k.startsWith(prefix)) dropImage(k)
  return dir
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
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  writeFileSync(blobPath(key, profile), data, { mode: 0o600 })
  chmodSync(blobPath(key, profile), 0o600)
  writeFileSync(metaPath(key, profile), JSON.stringify(meta), { mode: 0o600 })
  chmodSync(metaPath(key, profile), 0o600)
}

export type FetchImageOpts = {
  // Bound client for the account whose chat the image belongs to; also picks
  // that account's on-disk cache directory.
  client: GraphClient
  signal?: AbortSignal
  // When true, fetch directly over HTTPS with no Authorization
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
// (client.ctx). ic3 accounts go to asyncgw (the Graph endpoint is
// CA-gated); graph accounts use Graph and fall back to asyncgw when the
// object id is known: on 401 when audience fallback is enabled, and on 404
// always — cross-tenant 1:1 chats home the hosted content in the other
// tenant, so our tenant's Graph 404s while the asyncgw object store serves
// it (chat membership is in the object ACL).
async function fetchHostedContent(path: string, opts: FetchImageOpts): Promise<Uint8Array> {
  const { audience, fallback } = opts.client.ctx
  const objectId = opts.objectId
  const viaGraph = (): Promise<Uint8Array> =>
    opts.client.graphBinary({ method: 'GET', path, signal: opts.signal })
  const viaAsyncGw = async (): Promise<Uint8Array> => {
    const { bytes } = await fetchObjectById(objectId!, {
      account: opts.client.ctx.account,
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
        // 403: channel (thread.v2) hosted content Graph won't serve — the
        // asyncgw object store does (membership is in the object ACL).
        if ((fallback && err.status === 401) || err.status === 404 || err.status === 403) {
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
  opts: FetchImageOpts,
): Promise<Buffer | null> {
  const profile = owaProfile(opts.client.ctx.account)
  const cached = readCachedImage(key, profile)
  if (cached) return cached.data

  let bytes: Uint8Array
  try {
    if (opts?.isExternal && isAsyncGwUrl(path)) {
      // AsyncGW URLs aren't really "external" — they need a session
      // cookie obtained from aadtokenauth. Route them through the
      // asyncgw client which mints/refreshes the cookie as needed.
      const fetched = await fetchObjectByUrl(path, {
        account: opts.client.ctx.account,
        signal: opts.signal,
      })
      bytes = fetched.bytes
    } else if (opts?.isExternal) {
      bytes = await fetchExternalImage(path, opts?.signal)
    } else {
      bytes = await fetchHostedContent(path, opts)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    recordEvent('graph', 'warn', `image fetch failed for ${meta.name}: ${message}`)
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
  writeCachedImage(key, buf, { ...meta, size: bytes.byteLength }, profile)
  return buf
}

// In-memory status for images currently visible in the message pane.
// Avoids re-fetching on every render cycle.
type FetchStatus = 'pending' | 'loading' | 'ready' | 'error'

const fetchStatus = new Map<string, FetchStatus>()
const imageDataCache = new Map<string, Buffer>()

// The in-memory blobs are bounded by bytes, least recently read first out
// (Map order is the recency order). Every blob in memory is also on disk, so
// an evicted one also drops its 'ready' status: the next ensure* call reads
// it back from disk instead of trusting a status with no bytes behind it.
// Reads (getImageData) count as use, so the pictures on screen stay. The
// kitty transmit refs and avatar decodes are weak on the Buffer and go with
// it; copies the terminal holds are bounded by the terminal's own quota.
const DEFAULT_IMAGE_MEMORY_BUDGET = 64 * 1024 * 1024
let imageMemoryBudget = DEFAULT_IMAGE_MEMORY_BUDGET
let imageBytes = 0

function dropImage(owned: string): void {
  const buf = imageDataCache.get(owned)
  if (!buf) return
  imageBytes -= buf.byteLength
  imageDataCache.delete(owned)
}

function keepImage(owned: string, buf: Buffer): void {
  dropImage(owned)
  imageDataCache.set(owned, buf)
  imageBytes += buf.byteLength
  for (const old of imageDataCache.keys()) {
    // The newest blob stays even when it alone is over the budget.
    if (imageBytes <= imageMemoryBudget || old === owned) break
    dropImage(old)
    fetchStatus.delete(old)
  }
}

export function __setImageMemoryBudgetForTests(bytes?: number): void {
  imageMemoryBudget = bytes ?? DEFAULT_IMAGE_MEMORY_BUDGET
}

export function __imageMemoryBytesForTests(): number {
  return imageBytes
}

// Reads take the owning account; with none (no session bound yet) nothing
// is loaded.
export function getImageStatus(account: AccountId | undefined, key: string): FetchStatus {
  return (account && fetchStatus.get(ownedImageKey(account, key))) || 'pending'
}

export function getImageData(account: AccountId | undefined, key: string): Buffer | undefined {
  if (!account) return undefined
  const owned = ownedImageKey(account, key)
  const buf = imageDataCache.get(owned)
  if (buf) {
    // Most recently used: move to the end of the eviction order.
    imageDataCache.delete(owned)
    imageDataCache.set(owned, buf)
  }
  return buf
}

// Fetch an arbitrary image URL without auth headers. Applies the same
// size cap as the Graph path. Used by the gif-picker shape, where
// contentUrl is an external CDN URL (giphy/tenor) that rejects Bearer
// tokens.
const privateNetworks = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  privateNetworks.addSubnet(address, prefix, 'ipv4')
privateNetworks.addSubnet('::', 128, 'ipv6')
privateNetworks.addSubnet('::1', 128, 'ipv6')
privateNetworks.addSubnet('fc00::', 7, 'ipv6')
privateNetworks.addSubnet('fe80::', 10, 'ipv6')
privateNetworks.addSubnet('ff00::', 8, 'ipv6')

export function isPublicImageAddress(address: string, family: number): boolean {
  return !privateNetworks.check(address, family === 6 ? 'ipv6' : 'ipv4')
}

// Validate the address actually used by the socket, avoiding a second DNS
// resolution between validation and connection. HTTPS still verifies the
// original hostname. Node's request does not follow redirects.
const externalImageRequest = (url: string, init: RequestInit): Promise<Response> =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        signal: init.signal ?? undefined,
        agent: false,
        lookup(hostname, options, callback) {
          lookup(hostname, { all: true }, (err, addresses) => {
            if (err) return callback(err, [], undefined as never)
            if (
              !addresses.length ||
              addresses.some(({ address, family }) => !isPublicImageAddress(address, family))
            ) {
              return callback(new Error('private external image host'), [], undefined as never)
            }
            if (options.all) callback(null, addresses)
            else callback(null, addresses[0]!.address, addresses[0]!.family)
          })
        },
      },
      (res) => {
        const headers = new Headers()
        for (const [name, value] of Object.entries(res.headers)) {
          if (value !== undefined)
            headers.set(name, Array.isArray(value) ? value.join(', ') : value)
        }
        resolve(
          new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
            status: res.statusCode ?? 500,
            headers,
          }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })

let externalImageTransport = externalImageRequest
export function __setExternalImageTransportForTests(transport?: typeof externalImageRequest): void {
  externalImageTransport = transport ?? externalImageRequest
}

export async function fetchExternalImage(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const parsed = new URL(url)
  const host = parsed.hostname.replace(/\.$/, '')
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    isIP(host) ||
    host.startsWith('[') ||
    !host.includes('.') ||
    /(^|\.)(localhost|local|internal)$/.test(host)
  ) {
    throw new Error('unsafe external image URL')
  }
  const res = await sendWithBackoff(externalImageTransport, url, { signal, redirect: 'error' })
  if (!res.ok) {
    await res.body?.cancel()
    throw new Error(`external image fetch ${res.status} ${res.statusText}`)
  }
  if (Number(res.headers.get('content-length')) > MAX_IMAGE_BYTES) {
    await res.body?.cancel()
    throw new Error('external image too large')
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
      if (size > MAX_IMAGE_BYTES) throw new Error('external image too large')
      chunks.push(value)
    }
    return Buffer.concat(chunks, size)
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

// Trigger an async fetch for a key. Every caller that asked while it loads
// is told (onChange) when it settles. A failed fetch is retried by the next
// caller after INLINE_RETRY_MS, or at once when it was cancelled.
// ponytail: an over-size blob also retries every INLINE_RETRY_MS (one capped
// request); split final from transient failures if that shows up in logs.
const INLINE_RETRY_MS = 30_000
const inlineRetryAt = new Map<string, number>() // owned key -> when an error may retry
const inlineWaiters = new Map<string, Set<() => void>>() // owned key -> callers to notify

export function ensureImageFetched(
  path: string,
  key: string,
  meta: { contentType: string; name: string },
  opts: FetchImageOpts & { onChange: () => void },
): void {
  const owned = ownedImageKey(opts.client.ctx.account.id, key)
  const current = fetchStatus.get(owned)
  if (current === 'ready') return
  if (current === 'loading') {
    inlineWaiters.get(owned)?.add(opts.onChange)
    return
  }
  if (current === 'error' && Date.now() < (inlineRetryAt.get(owned) ?? Infinity)) return

  const disk = readCachedImage(key, owaProfile(opts.client.ctx.account))
  if (disk) {
    fetchStatus.set(owned, 'ready')
    keepImage(owned, disk.data)
    // Notify like the network path does: a caller that rendered a "loading…"
    // state before this ran would otherwise never learn the blob is available.
    // Safe against a render loop — the 'ready' guard above makes every later
    // call for this key return before reaching here.
    opts.onChange()
    return
  }

  fetchStatus.set(owned, 'loading')
  const waiters = new Set([opts.onChange])
  inlineWaiters.set(owned, waiters)
  const failed = (): void => {
    fetchStatus.set(owned, 'error')
    inlineRetryAt.set(owned, opts.signal?.aborted ? 0 : Date.now() + INLINE_RETRY_MS)
  }
  const settle = (): void => {
    inlineWaiters.delete(owned)
    for (const notify of waiters) notify()
  }
  fetchAndCacheImage(path, key, meta, opts)
    .then((buf) => {
      if (buf) {
        keepImage(owned, buf)
        fetchStatus.set(owned, 'ready')
      } else {
        failed()
      }
      settle()
    })
    .catch(() => {
      failed()
      settle()
    })
}

// Profile photos and team pictures share the image cache under these keys
// (Graph serves them as JPEG), with their own fetch path:
//   - the disk cache is always read first, whatever happened to requests;
//   - a 404 ("no photo") is remembered on disk for NO_PHOTO_TTL_MS;
//   - a 401 turns that kind (user / team) off for the account this session,
//     a 403 just that picture: initials show instead;
//   - any other failure (throttling after the client's own 429 retries,
//     5xx, network) is retried after PHOTO_RETRY_MS;
//   - at most MAX_PHOTO_FETCHES requests run at once per account, so a
//     screenful of new faces doesn't trip Graph's throttling;
//   - every caller waiting on a picture is told when it lands.
// ponytail: cached photos never refresh; clear the cache to pick up a new one.
export type PhotoKind = 'user' | 'team'

const NO_PHOTO_TTL_MS = 7 * 24 * 60 * 60 * 1000
const PHOTO_RETRY_MS = 60_000
const MAX_PHOTO_FETCHES = 4

const photoKindBlocked = new Set<string>() // `${account}\0${kind}` after a 401
const photoRetryAt = new Map<string, number>() // owned key -> when a failure may retry
const photoWaiters = new Map<string, Set<() => void>>() // owned key -> callers to notify
const photoQueues = new Map<AccountId, { active: number; waiting: (() => void)[] }>()

export function __forgetImagesInMemoryForTests(): void {
  fetchStatus.clear()
  imageDataCache.clear()
  imageBytes = 0
  inlineRetryAt.clear()
  inlineWaiters.clear()
}

export function __resetPhotoStateForTests(): void {
  photoKindBlocked.clear()
  photoRetryAt.clear()
  photoWaiters.clear()
  photoQueues.clear()
}

function noPhotoPath(key: string, profile?: string): string {
  const hash = createHash('sha1').update(key).digest('hex')
  return join(getCacheDir(profile), `${hash}.none`)
}

function hasNoPhotoMarker(key: string, profile?: string): boolean {
  try {
    return Date.now() - statSync(noPhotoPath(key, profile)).mtimeMs < NO_PHOTO_TTL_MS
  } catch {
    return false
  }
}

function enqueuePhotoFetch(account: AccountId, task: () => Promise<void>): void {
  let q = photoQueues.get(account)
  if (!q) photoQueues.set(account, (q = { active: 0, waiting: [] }))
  const queue = q
  const run = (): void => {
    queue.active++
    void task().finally(() => {
      queue.active--
      queue.waiting.shift()?.()
    })
  }
  if (queue.active < MAX_PHOTO_FETCHES) run()
  else queue.waiting.push(run)
}

function ensurePhoto(
  kind: PhotoKind,
  path: string,
  key: string,
  opts: { client: GraphClient; onChange: () => void },
): void {
  const account = opts.client.ctx.account
  const owned = ownedImageKey(account.id, key)
  const status = fetchStatus.get(owned)
  if (status === 'ready') return
  if (status === 'loading') {
    photoWaiters.get(owned)?.add(opts.onChange)
    return
  }
  if (status === 'error' && (photoRetryAt.get(owned) ?? Infinity) > Date.now()) return

  const profile = owaProfile(account)
  const disk = readCachedImage(key, profile)
  if (disk) {
    fetchStatus.set(owned, 'ready')
    keepImage(owned, disk.data)
    opts.onChange()
    return
  }
  const settle = (failed: boolean, retry: boolean): void => {
    fetchStatus.set(owned, failed ? 'error' : 'ready')
    if (retry) photoRetryAt.set(owned, Date.now() + PHOTO_RETRY_MS)
    else photoRetryAt.delete(owned)
  }
  if (hasNoPhotoMarker(key, profile) || photoKindBlocked.has(`${account.id}\0${kind}`)) {
    settle(true, false)
    return
  }

  fetchStatus.set(owned, 'loading')
  photoWaiters.set(owned, new Set([opts.onChange]))
  enqueuePhotoFetch(account.id, async () => {
    try {
      const bytes = await opts.client.graphBinary({ method: 'GET', path })
      if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('photo too large')
      const buf = Buffer.from(bytes)
      writeCachedImage(
        key,
        buf,
        { contentType: 'image/jpeg', name: key, size: buf.length },
        profile,
      )
      keepImage(owned, buf)
      settle(false, false)
    } catch (err) {
      const status = err instanceof GraphError ? err.status : null
      if (status === 404) {
        try {
          mkdirSync(getCacheDir(profile), { recursive: true, mode: 0o700 })
          chmodSync(getCacheDir(profile), 0o700)
          writeFileSync(noPhotoPath(key, profile), '', { mode: 0o600 })
          chmodSync(noPhotoPath(key, profile), 0o600)
        } catch {
          // best-effort: without the marker it's just asked again next launch
        }
        settle(true, false)
      } else if (status === 401) {
        const blockKey = `${account.id}\0${kind}`
        if (!photoKindBlocked.has(blockKey)) {
          photoKindBlocked.add(blockKey)
          recordEvent('graph', 'info', `${kind} pictures unavailable for this account (401)`)
        }
        settle(true, false)
      } else {
        settle(true, status !== 403)
      }
    }
    const waiters = photoWaiters.get(owned)
    photoWaiters.delete(owned)
    for (const notify of waiters ?? []) notify()
    // After a transient failure, tell the same callers again once the
    // cooldown ends, so they ask for the picture again.
    if (photoRetryAt.has(owned) && waiters?.size) {
      const timer = setTimeout(() => {
        for (const notify of waiters) notify()
      }, PHOTO_RETRY_MS)
      timer.unref?.()
    }
  })
}

export function userPhotoKey(userId: string, px: number): string {
  return `photo:user:${userId}:${px}`
}

export function teamPhotoKey(teamId: string): string {
  return `photo:team:${teamId}`
}

export function isPhotoKey(key: string): boolean {
  return key.startsWith('photo:')
}

export function ensureUserPhoto(
  userId: string,
  px: number,
  opts: { client: GraphClient; onChange: () => void },
): void {
  ensurePhoto(
    'user',
    `/users/${encodeURIComponent(userId)}/photos/${px}x${px}/$value`,
    userPhotoKey(userId, px),
    opts,
  )
}

export function ensureTeamPhoto(
  teamId: string,
  opts: { client: GraphClient; onChange: () => void },
): void {
  ensurePhoto(
    'team',
    `/teams/${encodeURIComponent(teamId)}/photo/$value`,
    teamPhotoKey(teamId),
    opts,
  )
}
