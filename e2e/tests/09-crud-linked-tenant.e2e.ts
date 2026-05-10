import {
  createOneOnOneChat,
  editMessage,
  listMessages,
  searchChatUsers,
  sendMessage,
  softDeleteMessage,
} from '../../src/graph/chats'
import { getMe } from '../../src/graph/me'
import type { E2ETest } from '../types'

// CRUD against a B2B-linked external user. The external email is
// configurable via --external-users; the test picks the first entry
// that resolves through Graph search (i.e. a tenant that is B2B-
// linked to the home tenant). Unlinked-tenant CRUD lives in a
// separate test that goes through the chatsvc external-search path.
const test: E2ETest = {
  name: 'crud-linked-tenant',
  description: 'Send + edit + soft-delete a 1:1 message with a B2B-linked external user',
  mutating: true,
  async run(ctx) {
    if (ctx.externalUsers.length === 0) {
      throw new Error('no external users configured (--external-users)')
    }
    const me = await getMe()
    if (!me.id) throw new Error('me.id is empty')

    // Find the first external user resolvable via Graph search (the
    // B2B-linked one). If none resolve, treat as a configuration miss
    // rather than a failure.
    let peerId: string | null = null
    let peerLabel = ''
    for (const email of ctx.externalUsers) {
      const matches = await searchChatUsers(email)
      const direct = matches.find(
        (m) =>
          m.userPrincipalName?.toLowerCase() === email.toLowerCase() ||
          m.mail?.toLowerCase() === email.toLowerCase(),
      )
      if (direct?.id) {
        peerId = direct.id
        peerLabel = `${direct.displayName ?? '(unnamed)'} <${email}>`
        break
      }
    }
    if (!peerId) {
      throw new Error(
        'no Graph-resolvable external user available - the B2B-linked test user is required for this test',
      )
    }
    ctx.log(`peer ${peerLabel} (${peerId})`)

    const chat = await createOneOnOneChat(me.id, peerId)
    ctx.log(`chat id=${chat.id}`)

    const stamp = new Date().toISOString()
    const initial = `[teaminal-e2e crud-linked] ping @ ${stamp}`
    const sent = await sendMessage(chat.id, initial)
    if (!sent.id) throw new Error('sendMessage returned no id')
    ctx.log(`sent message id=${sent.id}`)

    const messages = await listMessages(chat.id, { top: 50 })
    if (!messages.find((m) => m.id === sent.id)) {
      throw new Error('sent message not present in listMessages')
    }

    await editMessage(chat.id, sent.id, `${initial} (edited)`)
    ctx.log('edited OK')

    await softDeleteMessage(chat.id, sent.id)
    ctx.log('soft-delete OK')
  },
}

export default test
