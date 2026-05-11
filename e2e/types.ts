// e2e test definition shape.
//
// Each file under e2e/tests/ exports a default E2ETest. The runner
// imports them, runs them sequentially against the active owa-piggy
// profile, and prints a pass/fail summary.

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
