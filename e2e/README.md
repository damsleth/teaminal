# e2e tests

Runs the real Graph + chatsvc paths against the active owa-piggy
profile. Used to validate the chatsvc transport, federation resolver,
and the rest of the Microsoft 365 surface area without spawning a UI.

## Run

```bash
bun run e2e                     # all read-only tests, default profile
bun run e2e -- --profile work   # explicit owa-piggy profile
bun run e2e -- --filter chat    # only tests with "chat" in the name
bun run e2e -- --external-users alice@a.com,bob@b.com
```

Set defaults via env so you don't have to repeat the flags:

```bash
export TEAMINAL_E2E_PROFILE=work
export TEAMINAL_E2E_EXTERNAL_USERS=alice@a.com,bob@b.com
```

Mutating tests (sending messages, creating chats) are gated behind
`TEAMINAL_E2E_MUTATING=1`. Don't set that without thinking - those
tests post to your real Teams account.

The runner imports modules directly; no subprocess. Logs are redirected
to `.tmp/events.log` and `.tmp/network.log` (same paths the dev script
uses), and per-test offsets are captured so a failure prints just the
new lines from each log.

## Adding a test

Drop a file in `e2e/tests/` named `NN-name.e2e.ts` with a default
export of `E2ETest`:

```ts
import { getMe } from '../../src/graph/me'
import type { E2ETest } from '../types'

const test: E2ETest = {
  name: 'getMe',
  description: 'Identity probe via Graph /me',
  async run(ctx) {
    const me = await getMe()
    if (!me.id) throw new Error('me.id is empty')
    ctx.log(`me.displayName="${me.displayName}"`)
  },
  // mutating: true,  // opt in for sends/creates
}

export default test
```

Test files are run in lexical order. The number prefix lets us order
fast/cheap tests (identity, list) before slower ones (channel reads,
federation probes) so failures surface earliest.
