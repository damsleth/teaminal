import { listChannels, listJoinedTeams } from '../../src/graph/teams'
import type { E2ETest } from '../types'

const test: E2ETest = {
  name: 'listChannels',
  description: 'Channels for the first joined team return ≥1 channel',
  async run(ctx) {
    const teams = await listJoinedTeams()
    if (teams.length === 0) throw new Error('no joined teams to probe')
    const team = teams[0]!
    const channels = await listChannels(team.id)
    if (channels.length === 0) {
      throw new Error(`listChannels for "${team.displayName}" returned 0 channels`)
    }
    ctx.log(`team="${team.displayName}" channels=${channels.length}`)
    const general = channels.find((c) => c.displayName === 'General')
    ctx.log(general ? `default channel: General (${general.id})` : 'no General channel found')
  },
}

export default test
