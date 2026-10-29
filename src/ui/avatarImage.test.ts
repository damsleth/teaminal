import { afterEach, expect, test } from 'bun:test'
import { encode } from 'jpeg-js'
import {
  __resetAvatarDecodeCacheForTests,
  avatarCols,
  avatarEscape,
  avatarRows,
  iconEscape,
  iconKey,
  initialsKey,
  stampPresence,
} from './avatarImage'
import { __resetKittyImageIdsForTests, kittyImageId } from './kittyGraphics'
import { __resetKittyPainterForTests, requestKittyPaint, setKittyOwner } from './kittyPainter'

afterEach(() => {
  __resetAvatarDecodeCacheForTests()
  __resetKittyImageIdsForTests()
  __resetKittyPainterForTests()
})

function jpeg(width: number, height: number): Buffer {
  const data = Buffer.alloc(width * height * 4, 200)
  return Buffer.from(encode({ data, width, height }, 90).data)
}

test('sizes map to rows, and columns follow the cell aspect', () => {
  expect([
    avatarRows('off'),
    avatarRows('small'),
    avatarRows('medium'),
    avatarRows('large'),
  ]).toEqual([0, 1, 2, 3])
  expect(avatarCols(2)).toBe(4) // default aspect 0.5
})

test('a JPEG photo is sent as raw RGBA into an exact cell box, then placed by id', () => {
  const first = avatarEscape('acct\u0000photo:user:u1:48', jpeg(8, 8), 2)
  expect(first.startsWith('\x1b_Ga=T,f=32,s=8,v=8,')).toBe(true)
  expect(first).toContain('c=4,r=2')
  const again = avatarEscape('acct\u0000photo:user:u1:48', jpeg(8, 8), 2)
  expect(again).toBe(
    `\x1b_Ga=p,i=${kittyImageId('acct\u0000photo:user:u1:48')},c=4,r=2,C=1,z=17042,q=2\x1b\\`,
  )
})

test('undecodable data paints nothing', () => {
  expect(avatarEscape('k', Buffer.from('not an image'), 1)).toBe('')
})

test('the painter places every owner after one clear', async () => {
  const writes: string[] = []
  const stdout = { rows: 40, columns: 100, write: (s: string) => writes.push(s) } as never
  const node = (top: number) =>
    ({
      parentNode: undefined,
      yogaNode: {
        getComputedTop: () => top,
        getComputedLeft: () => 0,
        getComputedHeight: () => 2,
        getComputedWidth: () => 10,
      },
    }) as never
  const viewport = {
    parentNode: undefined,
    yogaNode: {
      getComputedTop: () => 0,
      getComputedLeft: () => 0,
      getComputedHeight: () => 40,
      getComputedWidth: () => 100,
    },
  } as never
  setKittyOwner('a', {
    viewport: () => viewport,
    slots: new Map([[node(1), { cacheKey: 'x', rows: 2, inset: 0 }]]),
    escape: () => 'IMG-A',
  })
  setKittyOwner('b', {
    viewport: () => viewport,
    slots: new Map([[node(5), { cacheKey: 'y', rows: 2, inset: 0 }]]),
    escape: () => 'IMG-B',
  })
  requestKittyPaint({ stdout, flush: () => Promise.resolve(), suppressed: false })
  await Promise.resolve()
  await Promise.resolve()
  const out = writes.join('')
  expect(out).toContain('IMG-A')
  expect(out).toContain('IMG-B')
})

test('group and meeting icons are drawn as pictures in the given color', () => {
  for (const icon of ['group', 'meeting'] as const) {
    const out = iconEscape(iconKey(icon, [10, 20, 30]), 2)
    expect(out.startsWith('\x1b_Ga=T,f=32,s=48,v=48,')).toBe(true)
    expect(out).toContain('c=4,r=2')
    // Some opaque pixels in the color (base64 of 0a141eff).
    const b64 = out.slice(out.indexOf(';') + 1, out.indexOf('\x1b\\'))
    expect(Buffer.from(b64, 'base64').includes(Buffer.from([10, 20, 30, 255]))).toBe(true)
  }
  expect(iconEscape('icon:nope:1,2,3', 2)).toBe('')
})

test('initials keys keep known letters and fold accents', () => {
  expect(initialsKey('cj')).toBe('initials:CJ')
  expect(initialsKey('ØÉ')).toBe('initials:ØE')
  expect(initialsKey('ЖЖ')).toBeNull()
  expect(initialsKey('')).toBeNull()
})

test('initials are drawn centered on a neutral square', () => {
  const out = iconEscape(initialsKey('CJ')!, 2)
  expect(out.startsWith('\x1b_Ga=T,f=32,s=66,v=66,')).toBe(true)
  const b64 = [...out.matchAll(/;([A-Za-z0-9+/=]+)\x1b\\/g)].map((m) => m[1]).join('')
  const px = Buffer.from(b64, 'base64')
  let [minX, maxX, minY, maxY] = [66, -1, 66, -1]
  for (let y = 0; y < 66; y++)
    for (let x = 0; x < 66; x++)
      if (px[(y * 66 + x) * 4] === 255) {
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
      }
  // Equal margins (within a pixel) on both axes.
  expect(Math.abs(minX - (65 - maxX))).toBeLessThanOrEqual(1)
  expect(Math.abs(minY - (65 - maxY))).toBeLessThanOrEqual(1)
  // The rest is the opaque background.
  expect([px[0], px[3]]).toEqual([140, 255])
})

test('presence stamp: badge in the bottom-right corner, bar down the left edge, source untouched', () => {
  const n = 48
  const src = { rgba: new Uint8Array(n * n * 4), width: n, height: n }
  const px = (p: { rgba: Uint8Array }, x: number, y: number) =>
    Array.from(p.rgba.slice((y * n + x) * 4, (y * n + x) * 4 + 4))
  const green: [number, number, number] = [0x6b, 0xb7, 0x00]
  const badge = stampPresence(src, { rgb: green, style: 'badge' })
  expect(px(badge, n - 10, n - 10)).toEqual([...green, 255])
  expect(px(badge, 0, 0)).toEqual([0, 0, 0, 0])
  expect(px(badge, 0, n - 1)).toEqual([0, 0, 0, 0])
  const bar = stampPresence(src, { rgb: green, style: 'bar' })
  expect(px(bar, 0, 0)).toEqual([...green, 255])
  expect(px(bar, 0, n - 1)).toEqual([...green, 255])
  expect(px(bar, n - 1, n - 1)).toEqual([0, 0, 0, 0])
  expect(src.rgba.every((v) => v === 0)).toBe(true)
})
