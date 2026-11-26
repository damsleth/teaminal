// Ink's useInput with DEC 1004 focus reports and SGR mouse reports removed.
//
// focusTracker enables focus reporting, so the terminal sends ESC[I / ESC[O
// on focus change. Ink strips the ESC and delivers "[I" / "[O" as typed
// text, which then lands in the composer and other text fields. Mouse
// reports ("[<0;10;5M", see ./mouse) arrive the same way. Every component
// imports useInput from here instead of from 'ink'.
//
// Exact match is enough: Ink splits a batched chunk ("\x1b[O\x1b[Ia") into
// one event per sequence, and it keeps a pasted literal "[I" intact.
// Mouse reports are dropped whatever the `mouse` setting, so a mode left on
// by a crashed run never types into the composer.
import { useInput as inkUseInput } from 'ink'
import { isMouseReport } from './mouse'

type Handler = Parameters<typeof inkUseInput>[0]
type Options = Parameters<typeof inkUseInput>[1]

export function isFocusReport(input: string): boolean {
  return input === '[I' || input === '[O'
}

export function useInput(handler: Handler, options?: Options): void {
  inkUseInput((input, key) => {
    if (isFocusReport(input) || isMouseReport(input)) return
    handler(input, key)
  }, options)
}
