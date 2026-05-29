#!/usr/bin/env node

const chats = [
  {
    name: 'Ada Byron',
    preview: 'The launch notes are ready for review.',
    unread: true,
    messages: ['Ada: The launch notes are ready for review.', 'You: I will read them now.'],
  },
  {
    name: 'Design Sync',
    preview: 'Nina shared two compact layout options.',
    unread: false,
    messages: ['Nina: Two compact layout options landed.', 'Kai: The second one scans faster.'],
  },
  {
    name: 'Ops Channel',
    preview: 'Deploy is green in the EU region.',
    unread: false,
    messages: ['Mina: Deploy is green in the EU region.', 'You: Good, leave the monitor open.'],
  },
]

let selected = 0
let menuOpen = false
let composerActive = false
let draft = ''

function color(code, value) {
  return `\u001b[${code}m${value}\u001b[39m`
}

function bold(value) {
  return `\u001b[1m${value}\u001b[22m`
}

function fit(value, width) {
  const chars = Array.from(value)
  if (chars.length > width) return chars.slice(0, width).join('')
  return value + ' '.repeat(width - chars.length)
}

function border(width, left, fill, right) {
  return left + fill.repeat(Math.max(0, width - 2)) + right
}

function render() {
  const active = chats[selected]
  const out = []
  out.push('\u001b[?25l\u001b[H\u001b[2J')
  out.push(color(36, border(100, '┌', '─', '┐')))
  out.push(
    color(36, '│') +
      ` ${bold('teaminal fixture')}${color(90, '  work  @2  realtime: connected')}` +
      color(36, fit('', 50) + '│'),
  )
  out.push(color(36, border(100, '└', '─', '┘')))
  out.push(color(90, border(30, '┌', '─', '┐') + border(48, '┌', '─', '┐')))
  out.push(
    color(90, '│') +
      bold(fit('Chats', 28)) +
      color(90, '││') +
      ` ${bold(fit(active.name, 44))}` +
      color(90, '│'),
  )
  for (let index = 0; index < 9; index++) {
    const chat = chats[index >> 1]
    const isNameRow = index % 2 === 0
    const left =
      chat && isNameRow
        ? `${index >> 1 === selected ? '>' : ' '} ${chat.unread ? '*' : ' '} ${chat.name}`
        : chat
          ? `   ${chat.preview}`
          : ''
    const right =
      index === 0
        ? color(90, 'Today')
        : index >= 1 && index <= active.messages.length
          ? active.messages[index - 1]
          : index === active.messages.length + 1
            ? color(90, 'seen by 3')
            : ''
    const leftColor =
      chat && index >> 1 === selected && isNameRow ? 36 : chat?.unread && isNameRow ? 33 : 39
    out.push(
      color(90, '│') +
        color(leftColor, fit(left, 28)) +
        color(90, '││') +
        ` ${fit(right, 44)}` +
        color(90, '│'),
    )
  }
  out.push(color(90, border(30, '└', '─', '┘') + border(48, '└', '─', '┘')))
  out.push(color(composerActive ? 36 : 90, border(100, '┌', '─', '┐')))
  out.push(
    color(composerActive ? 36 : 90, '│') +
      ` ${composerActive ? 'compose> ' : 'message> '}${fit(draft || 'Ctrl-T compose, Ctrl-A menu, Ctrl-C quit', 88)}` +
      color(composerActive ? 36 : 90, '│'),
  )
  out.push(color(composerActive ? 36 : 90, border(100, '└', '─', '┘')))
  if (menuOpen) {
    out.push(color(36, border(52, '╔', '═', '╗')))
    out.push(
      color(36, '║') +
        ` ${bold('Menu')}  Settings  Keybindings  Diagnostics` +
        fit('', 9) +
        color(36, '║'),
    )
    out.push(color(36, border(52, '╚', '═', '╝')))
  }
  process.stdout.write(`${out.join('\r\n')}\r\n`)
}

function handleInput(data) {
  for (const input of Array.from(data.toString('utf8'))) {
    handleKey(input)
  }
}

function handleKey(input) {
  if (input === '\u0003' || input === 'q') {
    process.stdout.write('\u001b[?25h\r\n')
    process.exit(0)
  }
  if (input === '\u0001' || input === 'm' || input === '\u001b') {
    menuOpen = !menuOpen
    render()
    return
  }
  if (input === '\u0014' || input === '\t') {
    composerActive = !composerActive
    render()
    return
  }
  if (composerActive) {
    if (input === '\r') draft = ''
    else if (input === '\u007f' || input === '\b') draft = draft.slice(0, -1)
    else if (/^[\x20-\x7e]+$/.test(input)) draft += input
    render()
    return
  }
  if (input === '\u000e' || input === 'j' || input === '\u001b[B') {
    selected = Math.min(chats.length - 1, selected + 1)
    render()
  } else if (input === 'k' || input === '\u001b[A') {
    selected = Math.max(0, selected - 1)
    render()
  }
}

if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.on('data', handleInput)
render()
