# teaminal

Lightweight terminal Microsoft Teams client. Bun + TypeScript + Ink + Microsoft Graph.

Auth is delegated to [`owa-piggy`](https://github.com/damsleth/owa-piggy) via subprocess. teaminal uses the default raw-token output and never asks `owa-piggy` for JSON, because the JSON mode can expose rotated refresh tokens.

## Status

Pre-alpha. See `.plans/teaminal.md` for the design contract and `AGENTS.md` for module structure.

## Platform Support

Compiled release binaries currently support macOS only:

| Platform            | Bun target         |
| ------------------- | ------------------ |
| macOS Apple Silicon | `bun-darwin-arm64` |
| macOS Intel         | `bun-darwin-x64`   |

Linux and Windows are not supported release targets yet. `scripts/build.sh` fails early for unsupported hosts or `TARGET` values.

## Prerequisites

- Bun for development and local builds.
- `owa-piggy` installed and authenticated for Microsoft Graph access.
- A terminal with raw-mode input support.

Set up `owa-piggy` first and verify it can return a Graph token:

```bash
owa-piggy token --audience graph >/dev/null
```

Use a named profile when needed:

```bash
teaminal --profile work
```

## Install

Homebrew support is provided through the `damsleth/tap` tap:

```bash
brew install damsleth/tap/teaminal
```

The current formula builds from source using Bun while release archives are
pending. You can also build directly from this repository:

```bash
bun install
bun run build
./dist/teaminal
```

## Develop

```bash
bun install
bun run dev
```

Useful commands:

```bash
bun test
bun run typecheck
bun run format
```

## Build

Build for the current supported macOS host:

```bash
bun run build
```

Cross-build one of the supported macOS targets:

```bash
TARGET=bun-darwin-arm64 ./scripts/build.sh
TARGET=bun-darwin-x64 ./scripts/build.sh
```

The binary is written to `dist/teaminal`. The build script runs `dist/teaminal --version` as a smoke test after compilation.

## Configuration

teaminal reads JSON settings once at startup from:

```text
${XDG_CONFIG_HOME:-~/.config}/teaminal/config.json
```

All keys are optional. Unknown keys and invalid values produce stderr warnings and fall back to defaults.

```json
{
  "theme": "dark",
  "accounts": [],
  "activeAccount": null,
  "chatListDensity": "cozy",
  "chatListShortNames": false,
  "showPresenceInList": true,
  "showTimestampsInPane": true,
  "windowHeight": 0,
  "messageFocusIndicatorEnabled": true,
  "messageFocusIndicatorChar": ">",
  "messageFocusIndicatorColor": null,
  "messageFocusBackgroundColor": null,
  "themeOverrides": {},
  "useTeamsPresence": true,
  "forceAvailableWhenFocused": true
}
```

<!-- prettier-ignore-start -->

| Key                            | Values               | Default | Description                                                                              |
| ------------------------------ | -------------------- | ------: | ---------------------------------------------------------------------------------------- |
| `theme`                        | `dark`, `light`      |  `dark` | Terminal color palette.                                                                  |
| `accounts`                     | string array         |    `[]` | owa-piggy profile aliases managed by Accounts.                                           |
| `activeAccount`                | string or null       |  `null` | Default profile alias used at startup when `--profile` is not passed.                    |
| `chatListDensity`              | `cozy`, `compact`    |  `cozy` | Row spacing in the chat list.                                                            |
| `chatListShortNames`           | boolean              | `false` | Show first names in chat list rows.                                                      |
| `showPresenceInList`           | boolean              |  `true` | Show presence dots in the chat list when available.                                      |
| `showTimestampsInPane`         | boolean              |  `true` | Show message timestamps in the message pane.                                             |
| `windowHeight`                 | non-negative integer |     `0` | `0` fills the terminal; any other value fixes the app height in rows.                    |
| `messageFocusIndicatorEnabled` | boolean              |  `true` | Show the focused-message marker while navigating messages.                               |
| `messageFocusIndicatorChar`    | single character     |     `>` | Marker shown beside the focused message.                                                 |
| `messageFocusIndicatorColor`   | color or null        |  `null` | Override focused-message marker color.                                                   |
| `messageFocusBackgroundColor`  | color or null        |  `null` | Optional focused-message background color.                                               |
| `themeOverrides`               | object               |    `{}` | Override color roles such as `text`, `mutedText`, `unread`, `timestamp`, and `presence`. |
| `useTeamsPresence`             | boolean              |  `true` | Use the Teams unified presence endpoint (`presence.teams.microsoft.com`) for own presence. Falls back to Graph `/me/presence` automatically on 401/403/404. Set to `false` to force Graph-only in tenants that block public-client access to that host. |
| `forceAvailableWhenFocused`    | boolean              |  `true` | While the terminal window has focus (DEC focus reporting; CSI ?1004), PUT `forceavailability=Available` to `presence.teams.microsoft.com` so Teams shows you Available, like the desktop client does for an active window. The override expires server-side after ~5 min and is refreshed inside that window. Set to `false` to leave presence to Teams' own desktop client / inactivity timer. |

<!-- prettier-ignore-end -->

The in-app Settings menu persists changes back to `config.json`.

## Keybindings

| Keys           | When              | Action                                                         |
| -------------- | ----------------- | -------------------------------------------------------------- |
| `j` / Down     | list              | Move cursor down.                                              |
| `k` / Up       | list              | Move cursor up.                                                |
| Enter          | list              | Open selected chat or channel.                                 |
| Tab            | chat / channel    | Enter composer.                                                |
| Esc            | composer / filter | Leave mode.                                                    |
| Esc            | chat / channel    | Return to chat list.                                           |
| Esc            | chat list         | Open menu.                                                     |
| Enter          | composer          | Send message.                                                  |
| Ctrl+J         | composer          | Insert newline.                                                |
| `/`            | list              | Filter chats.                                                  |
| `N`            | list              | Open the new-chat prompt.                                      |
| `A`            | Accounts          | Find valid `owa-piggy status` profiles to add.                 |
| `D` / Delete   | Accounts          | Remove the focused account from teaminal's list.               |
| `H` / Left     | chat / channel    | Return to chat list.                                           |
| `J` / Down     | chat / channel    | Focus next message.                                            |
| `K` / Up       | chat / channel    | Focus previous message.                                        |
| `L` / Right    | chat / channel    | Jump to latest message, or load older when focused at the top. |
| `U` / PageUp   | chat / channel    | Move up half a page.                                           |
| `D` / PageDown | chat / channel    | Move down half a page.                                         |
| `?`            | list              | Show keybindings.                                              |
| `r`            | any               | Refresh now.                                                   |
| `q`            | list / menu       | Quit.                                                          |
| Ctrl+C         | any               | Quit.                                                          |

Open the in-app keybindings reference with `?` from the list or through Help -> Keybindings.
