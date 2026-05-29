const KEY_BYTES: Record<string, string> = {
  enter: '\r',
  return: '\r',
  esc: '\u001b',
  escape: '\u001b',
  tab: '\t',
  backspace: '\u007f',
  up: '\u001b[A',
  down: '\u001b[B',
  right: '\u001b[C',
  left: '\u001b[D',
  'page-up': '\u001b[5~',
  'page-down': '\u001b[6~',
  'ctrl-a': '\u0001',
  'ctrl-c': '\u0003',
  'ctrl-d': '\u0004',
  'ctrl-n': '\u000e',
  'ctrl-t': '\u0014',
}

export function encodeKey(key: string): string {
  return KEY_BYTES[key] ?? key
}
