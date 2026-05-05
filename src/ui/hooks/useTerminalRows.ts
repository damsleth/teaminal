// Track real terminal rows as a state value. Ink's `height="100%"` resolves
// against intrinsic content height, not the terminal, so it lets the layout
// shrink/grow with content (e.g. switching between chats with different
// message counts visibly jumps the box). Setting an explicit row count
// pins the layout. When the user picks 'full', this hook drives that
// pinning by re-rendering on stdout.resize.

import { useStdout } from 'ink'
import { useEffect, useState } from 'react'

const FALLBACK_ROWS = 24

export function useTerminalRows(): number {
  const { stdout } = useStdout()
  const [rows, setRows] = useState<number>(stdout?.rows ?? FALLBACK_ROWS)
  useEffect(() => {
    if (!stdout) return
    const onResize = () => setRows(stdout.rows ?? FALLBACK_ROWS)
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])
  return rows
}
