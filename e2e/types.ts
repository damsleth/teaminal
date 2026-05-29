// e2e test definition shape.
//
// Each file under e2e/tests/ exports a default E2ETest. The runner
// imports them, runs them sequentially against the active owa-piggy
// profile, and prints a pass/fail summary.
//
// ALL e2e tests in this directory require a live owa-piggy auth profile
// (Microsoft Graph / Teams credentials) and are therefore excluded from CI.
// They are run manually by developers against their own tenant:
//
//   bun run e2e                          # all read-only tests
//   bun run e2e -- --profile work        # explicit profile
//   bun run e2e -- --filter chat         # subset by name
//   TEAMINAL_E2E_MUTATING=1 bun run e2e  # also run mutating tests
//
// The CI pipeline runs only `bun test` (unit tests) and
// `bunx @microsoft/tui-test` against the seeded offline app (no auth).

export type E2EContext = {
  profile: string
  externalUsers: string[]
  log: (msg: string) => void
}

export type E2ETest = {
  /** Short label for the run summary. */
  name: string
  /** Longer description shown above the test execution. */
  description?: string
  /**
   * Mark whether this test requires a live auth profile (always true for
   * Graph/Teams e2e tests — they are never run in CI). Defaults to true.
   * The runner does not enforce this flag; it is documentation only so
   * the CI exclusion intent is visible at the test level.
   */
  authGated?: boolean
  /**
   * Skip this test under certain conditions. Returning a string
   * skip-reason is preferred to silently skipping, so the runner can
   * surface why in the summary.
   */
  skip?: (ctx: E2EContext) => string | null | undefined
  /**
   * The test body. Throw to fail the test. The returned promise is
   * awaited; reject for async failures.
   */
  run: (ctx: E2EContext) => Promise<void>
  /**
   * Read-only by default. Tests that mutate user data (send messages,
   * create chats) must opt in with mutating: true; the runner refuses
   * to execute them unless TEAMINAL_E2E_MUTATING=1 is set.
   */
  mutating?: boolean
}
