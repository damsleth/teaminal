import { describe, expect, it } from 'bun:test'
import {
  TEAMINAL_KITTY_Z,
  buildKittyAPC,
  clearKittyImages,
  detectImageFormat,
  fitKittyPlacement,
  isKittyCapable,
  isKittyRenderable,
  writeKittyImageAtOffset,
} from './kittyGraphics'

describe('isKittyCapable', () => {
  it('returns true when KITTY_WINDOW_ID is set', () => {
    const original = process.env.KITTY_WINDOW_ID
    process.env.KITTY_WINDOW_ID = '1'
    expect(isKittyCapable()).toBe(true)
    if (original === undefined) delete process.env.KITTY_WINDOW_ID
    else process.env.KITTY_WINDOW_ID = original
  })

  it('returns true when TERM=xterm-kitty', () => {
    const orig = process.env.TERM
    delete process.env.KITTY_WINDOW_ID
    process.env.TERM = 'xterm-kitty'
    expect(isKittyCapable()).toBe(true)
    if (orig === undefined) delete process.env.TERM
    else process.env.TERM = orig
  })

  it('returns true when TERM_PROGRAM=kitty', () => {
    const origTerm = process.env.TERM
    const origProg = process.env.TERM_PROGRAM
    delete process.env.KITTY_WINDOW_ID
    process.env.TERM = 'xterm-256color'
    process.env.TERM_PROGRAM = 'kitty'
    expect(isKittyCapable()).toBe(true)
    if (origTerm === undefined) delete process.env.TERM
    else process.env.TERM = origTerm
    if (origProg === undefined) delete process.env.TERM_PROGRAM
    else process.env.TERM_PROGRAM = origProg
  })

  it('returns false when no Kitty env vars are set', () => {
    const origId = process.env.KITTY_WINDOW_ID
    const origTerm = process.env.TERM
    const origProg = process.env.TERM_PROGRAM
    const origGhostty = process.env.GHOSTTY_RESOURCES_DIR
    const origWez = process.env.WEZTERM_EXECUTABLE
    delete process.env.KITTY_WINDOW_ID
    delete process.env.GHOSTTY_RESOURCES_DIR
    delete process.env.WEZTERM_EXECUTABLE
    process.env.TERM = 'xterm-256color'
    delete process.env.TERM_PROGRAM
    expect(isKittyCapable()).toBe(false)
    if (origId !== undefined) process.env.KITTY_WINDOW_ID = origId
    if (origTerm === undefined) delete process.env.TERM
    else process.env.TERM = origTerm
    if (origProg !== undefined) process.env.TERM_PROGRAM = origProg
    if (origGhostty !== undefined) process.env.GHOSTTY_RESOURCES_DIR = origGhostty
    if (origWez !== undefined) process.env.WEZTERM_EXECUTABLE = origWez
  })
})

describe('buildKittyAPC', () => {
  const smallPng = pngBlob(64)

  it('single-chunk: wraps data in one APC sequence with m=0', () => {
    const apc = buildKittyAPC(smallPng, { cols: 40, reservedRows: 8 })
    expect(apc).toMatch(/^\x1b_Ga=T,f=100,c=40,C=1,z=17042,q=2,m=0;/)
    expect(apc).toEndWith('\x1b\\')
    expect(apc.split('\x1b_G').length).toBe(2)
  })

  it('multi-chunk: first has m=1, last has m=0', () => {
    // build a buffer large enough to exceed 4096 base64 chars (>3072 raw bytes)
    const big = pngBlob(4000)
    const apc = buildKittyAPC(big, { rows: 10, reservedRows: 10 })
    const parts = apc.split('\x1b\\').filter(Boolean)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts[0]).toContain('m=1')
    expect(parts[parts.length - 1]).toContain('m=0')
  })

  it('returns empty string for empty buffer', () => {
    expect(buildKittyAPC(Buffer.alloc(0), { rows: 10, reservedRows: 10 })).toBe('')
  })

  it('returns empty string for non-PNG blobs the terminal cannot decode', () => {
    // JPEG magic. Sending this down the f=100 (PNG) path is what left photos
    // as blank rows, so the encoder must refuse it.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a])
    expect(buildKittyAPC(jpeg, { cols: 40, reservedRows: 8 })).toBe('')
  })

  it('embeds exactly one dimension so the terminal preserves aspect ratio', () => {
    const byCols = buildKittyAPC(smallPng, { cols: 60, reservedRows: 5 })
    const byRows = buildKittyAPC(smallPng, { rows: 5, reservedRows: 5 })
    expect(byCols).toContain('c=60')
    expect(byCols).not.toContain('r=')
    expect(byRows).toContain('r=5')
    expect(byRows).not.toContain('c=')
  })

  it('disables terminal-side cursor movement for placements', () => {
    const apc = buildKittyAPC(smallPng, { cols: 60, reservedRows: 5 })
    expect(apc).toContain('C=1')
  })

  it('uses Teaminal-owned z-index for clearing stale placements', () => {
    const apc = buildKittyAPC(smallPng, { cols: 60, reservedRows: 5 })
    expect(apc).toContain(`z=${TEAMINAL_KITTY_Z}`)
  })
})

describe('fitKittyPlacement', () => {
  it('uses width-only placement when the image fits inside the row budget', () => {
    const wide = pngWithSize(800, 200)
    expect(fitKittyPlacement(wide, 80, 10)).toEqual({ cols: 80, reservedRows: 10 })
  })

  it('uses height-only placement when width-constrained display would be too tall', () => {
    const tall = pngWithSize(200, 800)
    expect(fitKittyPlacement(tall, 80, 10)).toEqual({ rows: 10, reservedRows: 10 })
  })

  it('falls back to height-only placement when dimensions cannot be read', () => {
    expect(fitKittyPlacement(Buffer.from('not png'), 80, 10)).toEqual({
      rows: 10,
      reservedRows: 10,
    })
  })
})

describe('writeKittyImageAtOffset', () => {
  it('moves to the requested terminal column before writing the image', () => {
    const writes: string[] = []
    const stdout = { write: (value: string) => writes.push(value) } as unknown as NodeJS.WriteStream
    writeKittyImageAtOffset(stdout, 'APC', 7, 4, 42)
    expect(writes.join('')).toBe('\x1b7\x1b[7A\x1b[42GAPC\x1b[4B\x1b8')
  })
})

describe('clearKittyImages', () => {
  it('deletes Teaminal-owned placements by z-index', () => {
    const writes: string[] = []
    const stdout = { write: (value: string) => writes.push(value) } as unknown as NodeJS.WriteStream
    clearKittyImages(stdout)
    expect(writes.join('')).toBe(`\x1b_Ga=d,d=Z,z=${TEAMINAL_KITTY_Z},q=2\x1b\\`)
  })
})

describe('detectImageFormat', () => {
  it('recognizes the formats Teams hands us', () => {
    expect(detectImageFormat(pngBlob(16))).toBe('png')
    expect(detectImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg')
    expect(detectImageFormat(Buffer.from('GIF89a'))).toBe('gif')
    expect(detectImageFormat(Buffer.from('RIFF\0\0\0\0WEBP'))).toBe('webp')
    expect(detectImageFormat(Buffer.from([0x42, 0x4d, 0x00, 0x00]))).toBe('bmp')
  })

  it('returns null for unknown or truncated blobs', () => {
    expect(detectImageFormat(Buffer.from('xx'))).toBeNull()
    expect(detectImageFormat(Buffer.alloc(0))).toBeNull()
  })
})

describe('isKittyRenderable', () => {
  it('is true only for PNG, the lone format Kitty decodes natively', () => {
    expect(isKittyRenderable(pngBlob(16))).toBe(true)
    expect(isKittyRenderable(Buffer.from([0xff, 0xd8, 0xff]))).toBe(false)
    expect(isKittyRenderable(Buffer.from('GIF89a'))).toBe(false)
  })
})

function pngWithSize(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24)
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

// A PNG-signed blob of the requested total length (>= 8 bytes).
function pngBlob(size: number): Buffer {
  const buf = Buffer.alloc(Math.max(8, size), 0x42)
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  return buf
}
