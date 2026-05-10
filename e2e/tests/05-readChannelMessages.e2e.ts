import { listChannelMessagesPage, listChannels, listJoinedTeams } from '../../src/graph/teams'
import type { E2ETest } from '../types'

// The chatsvc-only channel-message read path is the most fragile thing
// in the stack right now (FOCI can't issue ChannelMessage.Read.All, so
// Graph never works for this user's tenant - chatsvc is the only path
// and it has its own auth, region, and response-shape edge cases).
// This test exercises the active-poller's actual call path against a
// real channel and asserts we get at least one renderable message.
const test: E2ETest = {
  name: 'listChannelMessagesPage',
  description: 'Read channel messages via Teams chatsvc fallback',
  async run(ctx) {
    const teams = await listJoinedTeams()
    if (teams.length === 0) throw new Error('no joined teams to probe')
    // Iterate teams until we find one with a non-empty channel. Channel
    // permissioning varies, and a freshly-joined team can return 0
    // messages legitimately - we want at least one assertion of "the
    // chatsvc parser produced output".
    let probed = 0
    let lastError: Error | null = null
    for (const team of teams.slice(0, 5)) {
      const channels = await listChannels(team.id)
      const general = channels.find((c) => c.displayName === 'General') ?? channels[0]
      if (!general) continue
      probed++
      try {
        const page = await listChannelMessagesPage(team.id, general.id, { top: 20 })
        ctx.log(
          `team="${team.displayName}" channel="${general.displayName}" messages=${page.messages.length}`,
        )
        if (page.messages.length === 0) {
          lastError = new Error(
            `chatsvc returned 0 messages for ${team.displayName} / ${general.displayName} - check .tmp/events.log for diagnostic excerpt`,
          )
          continue
        }
        const sample = page.messages
          .slice(-3)
          .map((m) => {
            const sender = m.from?.user?.displayName ?? '(system)'
            const body = (m.body.content ?? '').slice(0, 60).replace(/\s+/g, ' ').trim()
            return `${sender}: ${body || '(empty)'}`
          })
          .join(' | ')
        ctx.log(`sample: ${sample}`)
        return
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
      }
    }
    if (probed === 0) throw new Error('no channels found across the first 5 teams')
    throw (
      lastError ??
      new Error(`exhausted ${probed} channels without finding any with messages`)
    )
  },
}

export default test
