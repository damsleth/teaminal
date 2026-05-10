import { listJoinedTeams } from '../../src/graph/teams'
import type { E2ETest } from '../types'

const test: E2ETest = {
  name: 'listJoinedTeams',
  description: 'GET /me/joinedTeams returns ≥1 team',
  async run(ctx) {
    const teams = await listJoinedTeams()
    if (teams.length === 0) throw new Error('listJoinedTeams returned 0 teams')
    ctx.log(`got ${teams.length} teams`)
    const sample = teams.slice(0, 5).map((t) => t.displayName).join(', ')
    ctx.log(`sample: ${sample}${teams.length > 5 ? ', ...' : ''}`)
  },
}

export default test
