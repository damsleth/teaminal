// React context for the PollerHandle.
//
// Held as a `{ current: PollerHandle | null }` ref because the handle is
// not available at first render (the bin entry kicks off auth + capability
// probe before startPoller). Components read `ref.current` inside event
// handlers; reactivity is not needed because the handle never changes
// after assignment.

import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import type { PollerHandleRef } from '../state/poller'

const PollerContext = createContext<PollerHandleRef | null>(null)

export function PollerProvider(props: { handleRef: PollerHandleRef; children: ReactNode }) {
  return <PollerContext.Provider value={props.handleRef}>{props.children}</PollerContext.Provider>
}

export function usePollerHandleRef(): PollerHandleRef {
  const ref = useContext(PollerContext)
  if (!ref) throw new Error('usePollerHandleRef must be used inside <PollerProvider>')
  return ref
}
