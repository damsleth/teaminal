import {
  createOneOnOneChat,
  editMessage,
  listMessages,
  sendMessage,
  softDeleteMessage,
} from '../../src/graph/chats'
import { getMe } from '../../src/graph/me'
import type { E2ETest } from '../types'

// Full message CRUD against a self-chat. createOneOnOneChat with
// otherUserId === selfUserId returns the existing self-chat (Microsoft
// Teams supports talking to yourself as a "Saved messages" surface),
// so we don't need to clean up the chat itself - just the messages we
// posted.
const test: E2ETest = {
  name: 'crud-self',
  description: 'Send + edit + soft-delete a message in the self-chat',
  mutating: true,
  async run(ctx) {
    const me = await getMe()
    if (!me.id) throw new Error('me.id is empty')
    const chat = await createOneOnOneChat(me.id, me.id)
    ctx.log(`self-chat id=${chat.id}`)

    const stamp = new Date().toISOString()
    const initial = `[teaminal-e2e crud-self] hello @ ${stamp}`
    const sent = await sendMessage(chat.id, initial)
    ctx.log(`sent message id=${sent.id}`)
    if (!sent.id) throw new Error('sendMessage returned no id')

    // Read it back to verify it landed.
    const messages = await listMessages(chat.id, { top: 50 })
    const found = messages.find((m) => m.id === sent.id)
    if (!found) throw new Error('sent message not present in listMessages')
    if (!found.body.content?.includes('hello')) {
      throw new Error(`message body did not round-trip: ${found.body.content?.slice(0, 80)}`)
    }
    ctx.log(`read-back OK (${messages.length} messages in chat)`)

    // Edit the message.
    const edited = `${initial} (edited)`
    await editMessage(chat.id, sent.id, edited)
    ctx.log('edited OK')

    // Soft-delete; the tombstone stays in the conversation but the
    // body is hidden. We don't assert the tombstone shape here - Graph
    // returns it eventually consistent, sometimes lagging the delete
    // call. We just verify the API call returns 2xx without throwing.
    await softDeleteMessage(chat.id, sent.id)
    ctx.log('soft-delete OK')
  },
}

export default test
