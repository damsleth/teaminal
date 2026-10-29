import { expect, test } from 'bun:test'
import { renderToString } from 'ink'
import type { ReactNode } from 'react'
import { Text, TextThemeContext } from './Text'

const render = (node: ReactNode) =>
  renderToString(
    <TextThemeContext.Provider value={{ text: '#123456', mutedText: '#abcdef' }}>
      {node}
    </TextThemeContext.Provider>,
  )

const THEMED = '\x1b[38;2;18;52;86m'
const MUTED = '\x1b[38;2;171;205;239m'

test('uncolored text takes the theme text color; nested text inherits its parent', () => {
  expect(render(<Text>a</Text>)).toContain(`${THEMED}a`)
  const nested = render(
    <Text color="#ff0000">
      x<Text bold>y</Text>
    </Text>,
  )
  expect(nested).not.toContain(THEMED)
})

test('muted text takes the theme muted color, nested or not', () => {
  expect(render(<Text muted>a</Text>)).toContain(`${MUTED}a`)
  expect(
    render(
      <Text>
        x<Text muted>y</Text>
      </Text>,
    ),
  ).toContain(`${MUTED}y`)
})
