import { afterEach, expect, test } from 'bun:test'
import { Box, Text, renderToString } from 'ink'
import {
  __setTextSizingSupportedForTests,
  expandTextSizing,
  fs,
  fsTall,
  nearestFraction,
  packLength,
  tallPacker,
  parseTextSizingProbe,
} from './textSizing'

afterEach(() => __setTextSizingSupportedForTests(false))

// eslint-disable-next-line no-control-regex
const stripOsc66 = (s: string) =>
  s.replace(/\x1b\]66;[^;]*;([^\x07]*)\x07/g, '$1').replace(/\x1b\]8;;\x07/g, '')

test('fs is a no-op without terminal support or at 100%', () => {
  expect(fs('hi', 70)).toBe('hi')
  __setTextSizingSupportedForTests(true)
  expect(fs('hi', 100)).toBe('hi')
})

test('sized text survives Ink layout and expands to per-cell OSC 66', () => {
  __setTextSizingSupportedForTests(true)
  const frame = renderToString(
    <Box width={12}>
      <Text>
        <Text color="red">{fs('ab 🐈', 70)}</Text>
        {' x'}
      </Text>
    </Box>,
    { columns: 12 },
  )
  const out = expandTextSizing(frame)
  // Layout unchanged: the marker is zero-width to Ink.
  // eslint-disable-next-line no-control-regex
  expect(stripOsc66(out).replace(/\x1b\[[0-9;]*m/g, '')).toBe('ab 🐈 x')
  expect(out).toContain('\x1b]66;n=7:d=10:v=1:w=1;a\x07')
  expect(out).toContain('\x1b]66;n=7:d=10:v=1:w=2;🐈\x07')
  expect(out).not.toContain('teaminal-fs')
  // Unsized text stays plain.
  expect(out).not.toContain(';x\x07')
})

test('wrapped sized text keeps every line marked', () => {
  __setTextSizingSupportedForTests(true)
  const frame = renderToString(
    <Box width={5}>
      <Text wrap="wrap">{fs('aaaa bbbb', 50)}</Text>
    </Box>,
    { columns: 5 },
  )
  const out = expandTextSizing(frame)
  expect(out.split('\n').map((l) => stripOsc66(l).trimEnd())).toEqual(['aaaa', 'bbbb'])
  expect(out).toContain('n=5:d=10:v=1:w=1;b')
})

test('probe reply: scale support only when the s=2 draw moves the cursor', () => {
  expect(parseTextSizingProbe('\x1b[5;1R\x1b[5;3R\x1b[5;5R')).toBe(true)
  expect(parseTextSizingProbe('\x1b[5;1R\x1b[5;1R\x1b[5;1R')).toBe(false)
  expect(parseTextSizingProbe('\x1b[5;1R\x1b[5;3R')).toBeNull()
})

test('pack length picks the least wasteful chunk, none at 90%', () => {
  expect([5, 6, 7, 8, 9].map(packLength)).toEqual([2, 5, 10, 5, null])
})

test('tight runs pack to the scaled pitch and pad the saved cells at the end', () => {
  __setTextSizingSupportedForTests(true)
  const frame = renderToString(
    <Box width={12}>
      <Text>
        <Text backgroundColor="blue">{fs('abcde', 50, true)}</Text>|
      </Text>
    </Box>,
    { columns: 12 },
  )
  const out = expandTextSizing(frame)
  expect(out).toContain('\x1b]66;n=5:d=10:v=1:w=1;ab\x07\x1b]66;n=5:d=10:v=1:w=1;cd\x07')
  expect(out).toContain('\x1b]66;n=5:d=10:v=1:w=1;e\x07  ')
  // Still 5 cells before the bar: 3 packed + 2 padding, inside the background.
  // eslint-disable-next-line no-control-regex
  expect(out).toMatch(/w=1;e\x07  \x1b\[49m/)
})

test('tall lines draw 2-row blocks and step over their lower half on the next line', () => {
  __setTextSizingSupportedForTests(true)
  const frame = renderToString(
    <Box flexDirection="column" width={16}>
      <Box>
        <Text>{'L|\nL|'}</Text>
        <Box height={2} width={13}>
          <Text>{fsTall('Ada', 100)}</Text>
        </Box>
        <Text>{'|\n|'}</Text>
      </Box>
      <Text>{'L|            |'}</Text>
    </Box>,
    { columns: 16 },
  )
  const [top, under, after] = expandTextSizing(frame).split('\n')
  // 1.5x, bottom-aligned: 'Ada' takes one 3-block (6 cells); fsTall reserved
  // the 3 extra cells, which the rewriter drops again.
  expect(top).toBe('L|\x1b]66;s=2:n=3:d=4:v=1:w=3;Ada\x07       |')
  // The reserved row: Ink's blanks under the blocks become a 6-col jump.
  expect(under).toBe('L|\x1b[6C       |')
  expect(after).toBe('L|            |')
})

test('tall packer and fractions stay within the spec limits', () => {
  expect(tallPacker(10).len).toBe(2)
  expect(nearestFraction(0.35)).toEqual([5, 14])
  for (let n = 5; n <= 15; n++) {
    const p = tallPacker(n)
    expect(p.cells(p.len) / 2).toBeLessThanOrEqual(7)
    expect(p.cells(p.len)).toBeLessThanOrEqual(Math.ceil((p.len * n) / 10) + 1)
  }
})
