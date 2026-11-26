import { afterEach, expect, test } from 'bun:test'
import { render } from 'ink'
import { PassThrough } from 'node:stream'
import { __resetKittyPainterForTests, type KittyOwner } from '../kittyPainter'
import { useKittyOwner } from './useKittyOwner'

afterEach(() => __resetKittyPainterForTests())

// An owner whose viewport() counts the paint passes it took part in.
function countingOwner(): KittyOwner & { paints: number } {
  const owner = {
    paints: 0,
    viewport: () => {
      owner.paints++
      return null
    },
    slots: new Map(),
    escape: () => '',
  }
  return owner
}

function Probe(props: { id: string; owner: KittyOwner | null; suppressed?: boolean }) {
  useKittyOwner(props.id, props.owner, props.suppressed ?? false)
  return null
}

function Panes(props: { list: KittyOwner | null; messages: KittyOwner | null }) {
  return (
    <>
      <Probe id="chat-list" owner={props.list} />
      <Probe id="messages" owner={props.messages} />
    </>
  )
}

const settle = () => new Promise((r) => setTimeout(r, 30))

function mount(node: React.ReactElement) {
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 })
  const written: string[] = []
  stdout.on('data', (chunk) => written.push(String(chunk)))
  const ink = render(node, { stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
  return { ink, written }
}

// kittyGraphics.clearKittyImages: our placements are cleared before each paint.
const CLEAR = '\x1b_Ga=d,d=z'
const clears = (written: string[]) => written.join('').split(CLEAR).length - 1

test('both panes are painted in one pass after the frame flush', async () => {
  const list = countingOwner()
  const messages = countingOwner()
  const { ink, written } = mount(<Panes list={list} messages={messages} />)
  await settle()
  expect(list.paints).toBeGreaterThan(0)
  expect(messages.paints).toBe(list.paints)
  expect(clears(written)).toBe(list.paints)
  ink.unmount()
})

test('a null owner leaves the painter and asks for no paint of its own', async () => {
  const list = countingOwner()
  const messages = countingOwner()
  const { ink, written } = mount(<Panes list={list} messages={messages} />)
  await settle()
  // The list turns thumbnails off: it is no longer painted.
  ink.rerender(<Panes list={null} messages={messages} />)
  await settle()
  const listPaints = list.paints
  const before = clears(written)
  // Re-renders with the list still off: the message pane's re-render paints
  // once; the list asks for nothing, so there is no extra clear for it.
  ink.rerender(<Panes list={null} messages={messages} />)
  await settle()
  expect(list.paints).toBe(listPaints)
  expect(clears(written) - before).toBe(1)
  ink.unmount()
})

test('a pane with no owner never requests a paint', async () => {
  const { ink, written } = mount(<Probe id="chat-list" owner={null} />)
  await settle()
  ink.rerender(<Probe id="chat-list" owner={null} />)
  await settle()
  expect(clears(written)).toBe(0)
  ink.unmount()
})

test('a suppressed paint (modal open) clears and places nothing', async () => {
  const messages = countingOwner()
  const { ink, written } = mount(<Probe id="messages" owner={messages} suppressed />)
  await settle()
  expect(clears(written)).toBeGreaterThan(0)
  expect(messages.paints).toBe(0)
  ink.unmount()
})

test('unmounting a pane removes it and repaints the others', async () => {
  const list = countingOwner()
  const messages = countingOwner()
  function Layout(props: { showList: boolean }) {
    return (
      <>
        {props.showList ? <Probe id="chat-list" owner={list} /> : null}
        <Probe id="messages" owner={messages} />
      </>
    )
  }
  const { ink } = mount(<Layout showList />)
  await settle()
  ink.rerender(<Layout showList={false} />)
  await settle()
  const listPaints = list.paints
  const messagePaints = messages.paints
  ink.rerender(<Layout showList={false} />)
  await settle()
  expect(list.paints).toBe(listPaints)
  expect(messages.paints).toBeGreaterThan(messagePaints)
  ink.unmount()
})
