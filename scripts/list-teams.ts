// Live smoke for src/graph/teams.
//
// Lists joined teams + their channels (with $select fields) to confirm the
// teams + channels endpoints work end-to-end against the user's tenant.

import { setActiveProfile } from '../src/graph/client'
import { listChannels, listJoinedTeams } from '../src/graph/teams'

const profile = Bun.argv[2]
if (profile) setActiveProfile(profile)

const t0 = performance.now()
const teams = await listJoinedTeams()
const tTeams = performance.now() - t0

process.stdout.write(`fetched ${teams.length} teams in ${tTeams.toFixed(0)}ms\n\n`)

if (teams.length === 0) {
  process.stdout.write(
    [
      'No joined teams. This is not necessarily a bug:',
      '  - Group chats (chatType: group) are NOT Microsoft Teams; they appear under listChats.',
      '  - /me/joinedTeams under delegated auth excludes teams where you are only a',
      '    shared-channel member (parked for after v1).',
      '  - Some tenants restrict /me/joinedTeams to specific Graph permissions; check',
      '    the access-token scp claim if you expected teams to appear.',
      '',
    ].join('\n'),
  )
  process.exit(0)
}

// Hydrate channels for each team in parallel; helpful as a poor-mans
// concurrency check on the wrapper.
const tCh0 = performance.now()
const results = await Promise.allSettled(
  teams.map(async (team) => ({ team, channels: await listChannels(team.id) })),
)
const tCh = performance.now() - tCh0

process.stdout.write(`fetched channels for ${results.length} teams in ${tCh.toFixed(0)}ms\n\n`)

for (const r of results) {
  if (r.status === 'rejected') {
    process.stdout.write(`! channel fetch failed: ${r.reason}\n`)
    continue
  }
  const { team, channels } = r.value
  process.stdout.write(`# ${team.displayName}  (${team.id})\n`)
  if (channels.length === 0) {
    process.stdout.write('  (no channels)\n')
    continue
  }
  for (const ch of channels) {
    const archived = ch.isArchived ? '  [archived]' : ''
    const memb = ch.membershipType ? `  ${ch.membershipType}` : ''
    process.stdout.write(`  - ${ch.displayName}${memb}${archived}\n`)
  }
}
