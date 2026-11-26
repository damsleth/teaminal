// Mouse events (see ./mouseTracker) for a component. The handler is read at
// event time, so it sees the latest render's props and state.

import { useEffect, useRef } from 'react'
import type { MouseEvent } from './mouse'
import { onMouse } from './mouseTracker'

export function useMouse(handler: (event: MouseEvent) => void): void {
  const latest = useRef(handler)
  latest.current = handler
  useEffect(() => onMouse((event) => latest.current(event)), [])
}
