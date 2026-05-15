import { describe, expect, it } from 'bun:test'
import { buildKittyAPC, isKittyCapable } from './kittyGraphics'

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
  const smallPng = Buffer.from('PNGDATA')

  it('single-chunk: wraps data in one APC sequence with m=0', () => {
    const apc = buildKittyAPC(smallPng, 40, 8)
    expect(apc).toMatch(/^\x1b_Ga=T,f=100,c=40,r=8,C=1,m=0;/)
    expect(apc).toEndWith('\x1b\\')
    expect(apc.split('\x1b_G').length).toBe(2)
  })

  it('multi-chunk: first has m=1, last has m=0', () => {
    // build a buffer large enough to exceed 4096 base64 chars (>3072 raw bytes)
    const big = Buffer.alloc(4000, 0x42)
    const apc = buildKittyAPC(big, 80, 10)
    const parts = apc.split('\x1b\\').filter(Boolean)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts[0]).toContain('m=1')
    expect(parts[parts.length - 1]).toContain('m=0')
  })

  it('returns empty string for empty buffer', () => {
    expect(buildKittyAPC(Buffer.alloc(0), 80, 10)).toBe('')
  })

  it('embeds correct cols and rows params', () => {
    const apc = buildKittyAPC(smallPng, 60, 5)
    expect(apc).toContain('c=60,r=5')
  })

  it('disables terminal-side cursor movement for placements', () => {
    const apc = buildKittyAPC(smallPng, 60, 5)
    expect(apc).toContain('C=1')
  })
})
