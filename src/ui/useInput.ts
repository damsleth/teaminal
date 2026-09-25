// Ink's useInput with DEC 1004 focus reports removed.
//
// focusTracker enables focus reporting, so the terminal sends ESC[I / ESC[O
// on focus change. Ink strips the ESC and delivers "[I" / "[O" as typed
// text, which then lands in the composer and other text fields. Every
// component imports useInput from here instead of from 'ink'.
import { useInput as inkUseInput } from 'ink'

type Handler = Parameters<typeof inkUseInput>[0]
type Options = Parameters<typeof inkUseInput>[1]

export function isFocusReport(input: string): boolean {
  return input === '[I' || input === '[O'
}

export function useInput(handler: Handler, options?: Options): void {
  inkUseInput((input, key) => {
    if (isFocusReport(input)) return
    handler(input, key)
  }, options)
}
