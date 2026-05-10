import { searchChatUsers } from '../../src/graph/chats'
import type { E2ETest } from '../types'

// Resolve the configured external test users via Graph people + users
// search (the same union teaminal's "new chat" prompt uses). Failure
// here usually means the search permissions are stricter than expected
// or the email is mistyped - either way it blocks federated chat
// creation.
const test: E2ETest = {
  name: 'resolveExternalUsers',
  description: 'Graph search resolves the configured federated test users',
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
      if (!direct) {
        ctx.log(`MISS "${email}" (search returned ${matches.length} candidates)`)
        failures.push(email)
        continue
      }
      ctx.log(`HIT  "${email}" -> ${direct.displayName ?? '(unnamed)'} (${direct.id})`)
    }
    if (failures.length > 0) {
      throw new Error(`failed to resolve: ${failures.join(', ')}`)
    }
  },
}

export default test
