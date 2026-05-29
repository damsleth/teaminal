# e2e tests

There are two complementary test suites:

## Graph / API e2e (`e2e/tests/`)

Runs the real Graph + chatsvc paths against the active owa-piggy
profile. Used to validate the chatsvc transport, federation resolver,
and the rest of the Microsoft 365 surface area without spawning a UI.
**Requires live auth** — these tests are not run in CI.

### Run

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

### Adding a Graph/API test

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

## TUI flow tests (`scripts/tui-loop/flows/`)

Drives the real Ink app through a headless PTY using
[`@microsoft/tui-test`](https://github.com/microsoft/tui-test). Runs in
**seeded offline mode** (`TEAMINAL_SEED=fixtures`) — no Microsoft 365 auth
needed. These tests run in CI on every push.

### Run

```bash
bun run tui:shots    # run all flow tests, emit manifest + PNG/SVG artifacts
bun run tui:update   # accept snapshot changes (after intentional UI changes)
bun run tui:trace    # replay a failing test from its recorded trace
bun run tui:flows    # list discovered flow test files
```

### Snapshot policy

- **Text/color `.snap` files** under `__snapshots__/` (co-located with each
  test file) are the CI gate. A mismatch fails the build.
- **PNG and SVG** renders are written to `.tui-loop/shots/<flow>/` and
  uploaded as CI artifacts. They are for human and agent visual review only —
  never a pass/fail gate.
- **Traces** under `.tui-test/` are also uploaded as artifacts so any failure
  can be replayed locally with `bun run tui:trace`.

### Adding a TUI flow test

Drop a `*.test.ts` file in `scripts/tui-loop/flows/`. The tui-test config
(`tui-test.config.ts`) picks it up automatically. Use the native tui-test API:

```ts
import { test, expect } from '@microsoft/tui-test'

test('chat list loads in seeded mode', async ({ terminal }) => {
  await terminal.wait(1000)
  const chatList = terminal.getByText(/Conversations/, { full: false })
  await expect(chatList).toBeVisible()
  await expect(terminal).toMatchSnapshot()
})
```

Call `captureTerminal(terminal, 'step-name', flowDir)` (from
`scripts/tui-loop/render.ts`) to also write PNG and SVG artifacts for that
step alongside the text snapshot.
