import { afterEach, expect, test } from 'bun:test'
import { Box, Text, renderToString } from 'ink'
import {
  __setTextSizingSupportedForTests,
  expandTextSizing,
  fs,
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
