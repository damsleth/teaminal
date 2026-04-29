// Top-level React error boundary.
//
// React 19 still uses the class-component error boundary API.
// componentDidCatch fires for synchronous render errors; async errors
// (promise rejections, setTimeout) bypass error boundaries entirely - the
// process-level uncaughtException handlers in bin/teaminal.tsx catch
// those instead.
//
// The fallback intentionally stays narrow: a single line with the
// message and a hint. The full stack goes to stderr via warn().

import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { Box, Text } from 'ink'
import { warn } from '../log'

type Props = { children: ReactNode }
type State = { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    warn('ErrorBoundary:', error.message)
    if (info.componentStack) warn('  componentStack:', info.componentStack.slice(0, 500))
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text color="red">teaminal crashed during render.</Text>
          <Text color="gray">{this.state.error.message}</Text>
          <Text color="gray">Press Ctrl+C to exit.</Text>
        </Box>
      )
    }
    return this.props.children
  }
}
