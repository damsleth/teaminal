export default {
  artifactsDir: '.tui-loop',
  viewport: {
    cols: 100,
    rows: 30,
  },
  launch: {
    command: 'node',
    args: ['scripts/tui-fixture.js'],
  },
  startupWaitMs: 1000,
  shutdownKey: 'q',
  flowTimeoutMs: 15000,
  flows: [
    {
      id: 'chat-shell',
      label: 'Chat shell',
      steps: [
        { type: 'waitForText', value: 'teaminal fixture' },
        { type: 'assertText', value: 'teaminal fixture' },
        { type: 'shot', name: 'initial-shell', label: 'Initial chat shell' },
        { type: 'key', key: 'j' },
        { type: 'waitForText', value: 'Design Sync' },
        { type: 'assertText', value: 'Design Sync' },
        { type: 'shot', name: 'chat-list-selection', label: 'Chat list selection moved down' },
      ],
    },
    {
      id: 'menu-and-composer',
      label: 'Menu and composer',
      steps: [
        { type: 'waitForText', value: 'teaminal fixture' },
        { type: 'key', key: 'm' },
        { type: 'waitForText', value: 'Settings  Keybindings  Diagnostics' },
        { type: 'assertText', value: 'Settings  Keybindings  Diagnostics' },
        { type: 'shot', name: 'menu-open', label: 'Menu overlay open' },
        { type: 'key', key: 'm', waitMs: 200 },
        { type: 'key', key: 'tab' },
        { type: 'waitForText', value: 'compose>' },
        { type: 'assertText', value: 'compose>' },
        { type: 'shot', name: 'composer-active', label: 'Composer active' },
      ],
    },
  ],
}
