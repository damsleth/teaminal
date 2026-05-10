import { getMe } from '../../src/graph/me'
import type { E2ETest } from '../types'

const test: E2ETest = {
  name: 'getMe',
  description: 'Identity probe via Graph /me',
  async run(ctx) {
    const me = await getMe()
    if (!me.id) throw new Error('me.id is empty')
    if (!me.displayName) throw new Error('me.displayName is empty')
    ctx.log(`me.id=${me.id} displayName="${me.displayName}" mail=${me.mail ?? '(none)'}`)
  },
}

export default test
