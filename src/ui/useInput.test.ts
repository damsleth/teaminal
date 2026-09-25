import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { isFocusReport } from './useInput'

describe('isFocusReport', () => {
  test('matches the de-escaped DEC 1004 reports only', () => {
    expect(isFocusReport('[I')).toBe(true)
    expect(isFocusReport('[O')).toBe(true)
    expect(isFocusReport('[')).toBe(false)
    expect(isFocusReport('I')).toBe(false)
    expect(isFocusReport('[Ia')).toBe(false)
  })

  test('no UI component imports the unfiltered hook from ink', () => {
    const offenders = readdirSync(import.meta.dir).filter((name) => {
      if (!/\.tsx?$/.test(name) || name === 'useInput.ts') return false
      const src = readFileSync(`${import.meta.dir}/${name}`, 'utf8')
      return /import \{[^}]*\buseInput\b[^}]*\} from 'ink'/.test(src)
    })
    expect(offenders).toEqual([])
  })
})
