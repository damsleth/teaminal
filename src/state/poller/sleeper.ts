// Interruptable sleeper. Each loop owns one; calling wake() resolves
// the current sleep early so the next iteration can run without waiting
// out the full interval. Used for focus-driven activeLoop refresh and
// for the user-facing manual-refresh key.
//
// close() is the stop-time variant: it wakes the in-flight sleep AND
// latches a 'closed' flag so any future sleep() call returns
// immediately. Without this latch, stop() can race with a loop whose
// previous sleep just resolved on the timer (waker is null in that
// window), leaving the loop to start a fresh sleep nobody can wake.

export type Sleeper = {
  sleep(ms: number): Promise<void>
  wake(): void
  /**
   * Permanently cancel this sleeper. The current in-flight sleep, if
   * any, resolves immediately. Subsequent sleep() calls are no-ops
   * (they resolve on the next microtask). Idempotent.
   */
  close(): void
}

export function makeSleeper(): Sleeper {
  let waker: (() => void) | null = null
  let closed = false
  return {
    sleep(ms: number) {
      if (closed) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const id = setTimeout(() => {
          waker = null
          resolve()
        }, ms)
        waker = () => {
          clearTimeout(id)
          waker = null
          resolve()
        }
      })
    },
    wake() {
      waker?.()
    },
    close() {
      closed = true
      waker?.()
    },
  }
}
