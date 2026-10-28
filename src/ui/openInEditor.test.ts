import { expect, test } from 'bun:test'
import { editorFromEnv, runEditor } from './openInEditor'

test('$VISUAL wins over $EDITOR; neither set means no editor', () => {
  expect(editorFromEnv({ VISUAL: 'nvim', EDITOR: 'vi' })).toBe('nvim')
  expect(editorFromEnv({ EDITOR: 'vi' })).toBe('vi')
  expect(editorFromEnv({ VISUAL: ' ' })).toBeNull()
})

test('the path reaches the editor as $1, never spliced into the command', () => {
  let seen: string[] = []
  const ok = runEditor('code -w', '/tmp/a b;rm -rf x.json', (cmd, args) => {
    seen = [cmd, ...args]
    return { status: 0, error: undefined }
  })
  expect(ok).toBe(true)
  expect(seen).toEqual(['sh', '-c', 'code -w "$1"', 'sh', '/tmp/a b;rm -rf x.json'])
})
