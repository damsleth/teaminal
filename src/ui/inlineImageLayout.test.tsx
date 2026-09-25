import { expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { Box, Text, render, type DOMElement } from 'ink'
import { elementRect, paintInlineImages, type InlineImageSlots } from './inlineImageLayout'

// Exercise real Yoga layout and Ink's flush, rather than duplicating the old
// row-counting formula in test expectations.
test('image placement follows its rendered slot through scrolling, chrome changes and clipping', async () => {
  const output = new PassThrough() as unknown as NodeJS.WriteStream
  output.columns = 80
  output.rows = 30
  let written = ''
  output.on('data', (data) => {
    written += data.toString()
  })
  let pane: DOMElement | null = null
  let slot: DOMElement | null = null
  let following: DOMElement | null = null
  const frame = (before: number, footer: number, imageRows = 4) => (
    <Box height={30} flexDirection="column">
      <Box height={3} flexShrink={0}>
        <Text>header</Text>
      </Box>
      <Box flexDirection="row" flexGrow={1}>
        <Box width={20}>
          <Text>chats</Text>
        </Box>
        <Box
          ref={(node) => {
            pane = node
          }}
          borderStyle="single"
          flexGrow={1}
          overflow="hidden"
          flexDirection="column"
        >
          <Box height={before} flexShrink={0}>
            <Text>preceding text</Text>
          </Box>
          <Box
            ref={(node) => {
              slot = node
            }}
            height={imageRows}
            flexShrink={0}
          >
            <Text>│</Text>
          </Box>
          <Box
            ref={(node) => {
              following = node
            }}
          >
            <Text>following message</Text>
          </Box>
        </Box>
      </Box>
      <Box height={footer} flexShrink={0}>
        <Text>composer and tails</Text>
      </Box>
    </Box>
  )
  const app = render(frame(2, 4), {
    stdout: output,
    stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    stderr: new PassThrough() as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  const paint = () => {
    written = ''
    const slots: InlineImageSlots = new Map([[slot!, { cacheKey: 'test', rows: 4, inset: 1 }]])
    paintInlineImages(output, pane!, slots, () => '<image>')
    return written
  }
  try {
    await app.waitUntilRenderFlush()
    expect(elementRect(slot!).top).toBe(6)
    expect(elementRect(following!).top).toBe(10)
    expect(paint()).toBe('\x1b7\x1b[7;23H<image>\x1b8')
    app.rerender(frame(2, 10))
    await app.waitUntilRenderFlush()
    // Less empty space below the timeline must not move the picture.
    expect(paint()).toBe('\x1b7\x1b[7;23H<image>\x1b8')
    app.rerender(frame(1, 10))
    await app.waitUntilRenderFlush()
    expect(paint()).toBe('\x1b7\x1b[6;23H<image>\x1b8')
    app.rerender(frame(15, 10))
    await app.waitUntilRenderFlush()
    expect(paint()).toBe('')
  } finally {
    app.unmount()
  }
})
