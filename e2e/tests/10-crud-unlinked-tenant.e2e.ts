import {
  createOneOnOneChat,
  editMessage,
  listMessages,
  searchChatUsers,
  sendMessage,
  softDeleteMessage,
} from '../../src/graph/chats'
import { getMe } from '../../src/graph/me'
import { searchExternalUsers } from '../../src/graph/teamsExternalSearch'
import type { E2ETest } from '../types'

// CRUD against a fully external (no B2B link) user. Differs from the
// linked-tenant flow in two places:
//   1. User resolution: Graph search misses, so we fall back to the
//      Teams chatsvc-side `searchUsers` endpoint (the same path the
//      new-chat prompt uses on Enter when in-tenant search empties).
//   2. Chat creation: Graph /chats may 403 in tenants without B2B
//      consent. The test reports that explicitly so we can iterate
//      on the chatsvc thread-create fallback if it surfaces.
const test: E2ETest = {
  name: 'crud-unlinked-tenant',
  description: 'CRUD with an unlinked-tenant user via the external-search fallback',
  mutating: true,
  async run(ctx) {
    if (ctx.externalUsers.length === 0) {
      throw new Error('no external users configured')
    }
    const me = await getMe()
    if (!me.id) throw new Error('me.id is empty')

    // Pick the first external user that is NOT Graph-resolvable -
    // that's the unlinked-tenant case. If every configured user
    // resolves through Graph, this test has nothing to exercise.
    let unlinkedEmail: string | null = null
    for (const email of ctx.externalUsers) {
      const matches = await searchChatUsers(email)
      const direct = matches.find(
        (m) =>
          m.userPrincipalName?.toLowerCase() === email.toLowerCase() ||
          m.mail?.toLowerCase() === email.toLowerCase(),
      )
      if (!direct) {
        unlinkedEmail = email
        break
      }
    }
    if (!unlinkedEmail) {
      throw new Error(
        'every configured external user is Graph-resolvable; no unlinked-tenant case to exercise',
      )
    }
    ctx.log(`unlinked-tenant peer: ${unlinkedEmail}`)

    const externalHits = await searchExternalUsers(unlinkedEmail)
    if (externalHits.length === 0) {
      throw new Error(`Teams external search returned 0 hits for ${unlinkedEmail}`)
    }
    const peer = externalHits[0]!
    ctx.log(`external search resolved -> ${peer.displayName ?? '(unnamed)'} (${peer.id})`)

    let chatId: string
    try {
      const chat = await createOneOnOneChat(me.id, peer.id)
      chatId = chat.id
      ctx.log(`chat id=${chatId} (Graph create accepted)`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Graph chat creation rejected for unlinked-tenant peer ${peer.id}: ${msg}. ` +
          'A chatsvc thread-create fallback is needed; see docs/external-user-search.md.',
      )
    }

    const stamp = new Date().toISOString()
    const initial = `[teaminal-e2e crud-unlinked] ping @ ${stamp}`
    const sent = await sendMessage(chatId, initial)
    if (!sent.id) throw new Error('sendMessage returned no id')
    ctx.log(`sent message id=${sent.id}`)

    const messages = await listMessages(chatId, { top: 50 })
    if (!messages.find((m) => m.id === sent.id)) {
      throw new Error('sent message not present in listMessages')
    }

    await editMessage(chatId, sent.id, `${initial} (edited)`)
    ctx.log('edited OK')

    await softDeleteMessage(chatId, sent.id)
    ctx.log('soft-delete OK')
  },
}

export default test
