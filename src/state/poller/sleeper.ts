// Interruptable sleeper. Each loop owns one; calling wake() resolves
// the current sleep early so the next iteration can run without waiting
// out the full interval. Used for focus-driven activeLoop refresh and
// for the user-facing manual-refresh key.

export type Sleeper = {
  sleep(ms: number): Promise<void>
  wake(): void
}

export function makeSleeper(): Sleeper {
  let waker: (() => void) | null = null
  return {
    sleep(ms: number) {
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
  }
}
