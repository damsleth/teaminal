import { listChats } from '../../src/graph/chats'
import type { E2ETest } from '../types'

const test: E2ETest = {
  name: 'listChats',
  description: 'Active chat list returns ≥1 chat',
  async run(ctx) {
    const chats = await listChats()
    if (chats.length === 0) throw new Error('listChats returned 0 chats')
    ctx.log(`got ${chats.length} chats`)
    const oneOnOne = chats.filter((c) => c.chatType === 'oneOnOne').length
    const group = chats.filter((c) => c.chatType === 'group').length
    const meeting = chats.filter((c) => c.chatType === 'meeting').length
    ctx.log(`types: oneOnOne=${oneOnOne} group=${group} meeting=${meeting}`)
  },
}

export default test
