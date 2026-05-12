# teaminal

[![CI](https://github.com/damsleth/teaminal/actions/workflows/ci.yml/badge.svg)](https://github.com/damsleth/teaminal/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/damsleth/teaminal.svg)](https://github.com/damsleth/teaminal/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-bun-black.svg)](https://bun.sh)

Lightweight, keyboard-driven terminal Microsoft Teams client. Read your
chats and channels, send messages, manage presence, and skim mentions
without opening the desktop app. Bun + TypeScript + Ink + Microsoft Graph.

Auth is delegated to [`owa-piggy`](https://github.com/damsleth/owa-piggy)
via subprocess - teaminal never sees your refresh token and is not an
Azure AD app registration.

> Status: pre-1.0. The chat surface is solid; channels, presence, and
> notifications are usable; the experimental real-time push transport
> is opt-in. See [CHANGELOG.md](./CHANGELOG.md) for what's shipped.

## Install

Homebrew (recommended on macOS):

```bash
brew install damsleth/tap/owa-piggy   # auth broker (one-time setup)
brew install damsleth/tap/teaminal
```

Build from source (any platform with Bun `>= 1.1.0`):

```bash
git clone https://github.com/damsleth/teaminal
cd teaminal
bun install
bun run build
./dist/teaminal
```

Release binaries are attached to each [GitHub Release][releases] for
macOS (arm64 + x64), Linux (x64 + arm64), and Windows (x64).

[releases]: https://github.com/damsleth/teaminal/releases

## Quickstart

```bash
# 1. One-time owa-piggy setup (opens Edge, signs you in, captures a
#    refresh token tied to your existing Outlook web session).
owa-piggy setup --profile work --email you@yourcompany.com

# 2. Verify owa-piggy can mint a Graph token.
owa-piggy token --audience graph >/dev/null

# 3. Launch teaminal.
teaminal --profile work
```

Channel message reads and sends require delegated Graph scopes
`ChannelMessage.Read.All` and `ChannelMessage.Send`. Broader group
scopes such as `Group.ReadWrite.All` do not satisfy those endpoints.

## Platform support

| Platform            | Release artifact suffix |
| ------------------- | ----------------------- |
| macOS Apple Silicon | `darwin-arm64.tar.gz`   |
| macOS Intel         | `darwin-x64.tar.gz`     |
| Linux x64           | `linux-x64.tar.gz`      |
| Linux arm64         | `linux-arm64.tar.gz`    |
| Windows x64         | `windows-x64.zip`       |

## Configuration

teaminal reads JSON settings once at startup from:

```text
${XDG_CONFIG_HOME:-~/.config}/teaminal/config.json
```

All keys are optional. Unknown keys and invalid values produce stderr
warnings and fall back to defaults.

```json
{
  "theme": "dark",
  "accounts": [],
  "activeAccount": null,
  "chatListDensity": "cozy",
  "chatListShortNames": false,
  "showPresenceInList": true,
  "showTimestampsInPane": true,
  "showReactions": "current",
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
| `showReactions`                | `off`, `current`, `all` | `current` | Show message reactions never, only on the focused message, or on every message.      |
| `messageFocusIndicatorEnabled` | boolean              |  `true` | Show the focused-message marker while navigating messages.                               |
| `messageFocusIndicatorChar`    | single character     |     `>` | Marker shown beside the focused message.                                                 |
| `messageFocusIndicatorColor`   | color or null        |  `null` | Override focused-message marker color.                                                   |
| `messageFocusBackgroundColor`  | color or null        |  `null` | Optional focused-message background color.                                               |
| `themeOverrides`               | object               |    `{}` | Override color roles such as `text`, `mutedText`, `unread`, `timestamp`, and `presence`. |
| `useTeamsPresence`             | boolean              |  `true` | Use the Teams unified presence endpoint (`presence.teams.microsoft.com`) for own presence. Falls back to Graph `/me/presence` automatically on 401/403/404. Set to `false` to force Graph-only in tenants that block public-client access to that host. |
| `forceAvailableWhenFocused`    | boolean              |  `true` | While the terminal window has focus (DEC focus reporting; CSI ?1004), PUT `forceavailability=Available` to `presence.teams.microsoft.com` so Teams shows you Available, like the desktop client does for an active window. The override expires server-side after ~5 min and is refreshed inside that window. Set to `false` to leave presence to Teams' own desktop client / inactivity timer. |
| `realtimeEnabled`              | boolean              | `false` | Enables the experimental Teams trouter push transport for typing, read-receipt, presence, and immediate refresh signals. Polling remains the source of truth and fallback. |

<!-- prettier-ignore-end -->

The in-app Settings menu persists changes back to `config.json`.

## Keybindings

| Keys           | When              | Action                                                         |
| -------------- | ----------------- | -------------------------------------------------------------- |
| `j` / Down     | list              | Move cursor down.                                              |
| `k` / Up       | list              | Move cursor up.                                                |
| `u` / PageUp   | list              | Move up half a page.                                           |
| `d` / PageDown | list              | Move down half a page.                                         |
| Enter          | list              | Open selected chat or channel.                                 |
| Tab            | chat / channel    | Toggle between message navigation and composer.                |
| Tab            | composer          | Return to message navigation.                                  |
| Esc            | composer / filter | Leave mode.                                                    |
| Esc            | chat / channel    | Return to chat list.                                           |
| Esc            | chat list         | Open menu.                                                     |
| Enter          | composer          | Send message.                                                  |
| Ctrl+J         | composer          | Insert newline.                                                |
| `/`            | list              | Filter chats.                                                  |
| `n`            | list              | Open the new-chat prompt.                                      |
| `a`            | Accounts          | Find valid `owa-piggy status` profiles to add.                 |
| `d` / Delete   | Accounts          | Remove the focused account from teaminal's list.               |
| `h` / Left     | chat / channel    | Return to chat list.                                           |
| `j` / Down     | chat / channel    | Focus next message.                                            |
| `k` / Up       | chat / channel    | Focus previous message, or load older when focused at the top. |
| `l` / Right    | chat / channel    | Jump to latest message.                                        |
| `u` / PageUp   | chat / channel    | Move up half a page, or load older if that reaches the top.    |
| `d` / PageDown | chat / channel    | Move down half a page.                                         |
| `?`            | list              | Show keybindings.                                              |
| `r`            | any               | Refresh now.                                                   |
| `Shift+R`      | any               | Hard refresh: clear visible data and reload from Graph.        |
| `q`            | list / menu       | Quit.                                                          |
| Ctrl+C         | any               | Quit.                                                          |

Open the in-app keybindings reference with `?` from the list or
through Help -> Keybindings.

## Security

teaminal piggybacks on
[`owa-piggy`](https://github.com/damsleth/owa-piggy) for auth, which
itself piggybacks on Microsoft's first-party OWA SPA client. There is
no app registration, no client secret, no tenant admin ask - and no
SLA. Microsoft can change the rules any Tuesday.

The threat model and the boundaries teaminal enforces (no
`--json`-mode `owa-piggy` calls, no logged `Authorization` headers,
no shell interpolation in notifications) are documented in
[`SECURITY.md`](./SECURITY.md). Report vulnerabilities via GitHub's
[private vulnerability reporting][advisory] for this repo.

[advisory]: https://github.com/damsleth/teaminal/security/advisories/new

## Contributing

Patches, bug reports, and design feedback welcome. See
[`CONTRIBUTING.md`](./CONTRIBUTING.md) for the setup flow, architecture
rules, test expectations, and the do/don't list. Read
[`AGENTS.md`](./AGENTS.md) before changing anything non-trivial.

## License

[MIT](./LICENSE).
