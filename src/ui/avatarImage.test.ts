import { afterEach, expect, test } from 'bun:test'
import { encode } from 'jpeg-js'
import {
  __resetAvatarDecodeCacheForTests,
  avatarCols,
  avatarEscape,
  avatarRows,
  iconEscape,
  iconKey,
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
