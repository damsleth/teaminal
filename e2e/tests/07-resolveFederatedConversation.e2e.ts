import { searchChatUsers } from '../../src/graph/chats'
import { getMe } from '../../src/graph/me'
import { resolveFederatedEquivalentConversationId } from '../../src/graph/teamsFederation'
import type { E2ETest } from '../types'

// For each configured external user, run the federated equivalent
// resolver. A null return is acceptable (no chat exists yet); a thrown
// error - especially a chatsvc 401 - means the Skype-token auth chain
// or the URL is wrong. We're verifying the *plumbing*, not that a chat
// actually exists.
const test: E2ETest = {
  name: 'resolveFederatedEquivalentConversationId',
  description: 'Federated chat resolver plumbing for the configured test users',
  async run(ctx) {
    if (ctx.externalUsers.length === 0) {
      throw new Error('no external users configured')
    }
    const me = await getMe()
    if (!me.id) throw new Error('me.id required')
    for (const email of ctx.externalUsers) {
      const matches = await searchChatUsers(email)
      const peer = matches.find(
        (m) =>
          m.userPrincipalName?.toLowerCase() === email.toLowerCase() ||
          m.mail?.toLowerCase() === email.toLowerCase(),
      )
      if (!peer || !peer.id) {
        ctx.log(`SKIP "${email}" - search did not surface an AAD id`)
        continue
      }
      const resolved = await resolveFederatedEquivalentConversationId(me.id, peer.id)
      ctx.log(
        resolved
          ? `${email} -> ${resolved}`
          : `${email} -> null (no existing federated chat, plumbing OK)`,
      )
    }
  },
}

export default test
