import { expect, test } from 'bun:test'
import { renderToString } from 'ink'
import type { ReactNode } from 'react'
import { Text, TextColorContext } from './Text'

const render = (node: ReactNode) =>
  renderToString(<TextColorContext.Provider value="#123456">{node}</TextColorContext.Provider>)

const THEMED = '\x1b[38;2;18;52;86m'

test('uncolored text takes the theme text color; nested text inherits its parent', () => {
  expect(render(<Text>a</Text>)).toContain(`${THEMED}a`)
  const nested = render(
    <Text color="#ff0000">
      x<Text bold>y</Text>
    </Text>,
  )
  expect(nested).not.toContain(THEMED)
})
