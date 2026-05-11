import { searchChatUsers } from '../../src/graph/chats'
import { searchExternalUsers } from '../../src/graph/teamsExternalSearch'
import type { E2ETest } from '../types'

// Resolve every configured external test user via the same two-step
// path the new-chat prompt uses: Graph search first (in-tenant + B2B
// linked), then a Teams chatsvc-side `searchUsers` fallback for
// fully-external tenants. The test passes if every user is reachable
// via at least one path.
const test: E2ETest = {
  name: 'resolveExternalUsers',
  description: 'Graph + Teams external search resolves the configured federated test users',
  async run(ctx) {
    if (ctx.externalUsers.length === 0) {
      throw new Error('no external users configured (--external-users)')
    }
    const failures: string[] = []
    for (const email of ctx.externalUsers) {
      const matches = await searchChatUsers(email)
      const direct = matches.find(
        (m) =>
          m.userPrincipalName?.toLowerCase() === email.toLowerCase() ||
          m.mail?.toLowerCase() === email.toLowerCase(),
      )
      if (direct) {
        ctx.log(`HIT (Graph)    "${email}" -> ${direct.displayName ?? '(unnamed)'} (${direct.id})`)
        continue
      }
      const externalHits = await searchExternalUsers(email, { top: 5 })
      const externalDirect = externalHits.find(
        (m) =>
          m.userPrincipalName?.toLowerCase() === email.toLowerCase() ||
          m.mail?.toLowerCase() === email.toLowerCase(),
      )
      if (externalDirect) {
        ctx.log(
          `HIT (external) "${email}" -> ${externalDirect.displayName ?? '(unnamed)'} (${externalDirect.id})`,
        )
        continue
      }
      ctx.log(
        `MISS           "${email}" (Graph hits=${matches.length}, external hits=${externalHits.length})`,
      )
      failures.push(email)
    }
    if (failures.length > 0) {
      throw new Error(`failed to resolve: ${failures.join(', ')}`)
    }
  },
}

export default test
