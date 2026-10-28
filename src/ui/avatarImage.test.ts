import { afterEach, expect, test } from 'bun:test'
import { encode } from 'jpeg-js'
import {
  __resetAvatarDecodeCacheForTests,
  avatarCols,
  avatarEscape,
  avatarRows,
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
