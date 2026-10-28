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
  "chatListShortNames": false,
  "chatListPreviewLines": 1,
  "messagePaneShortNames": true,
  "showPresenceInList": true,
  "showTimestampsInPane": "on",
  "centerDateMarkers": false,
  "showSenderNamesInPane": true,
  "showOwnNameInPane": true,
  "showReactions": "current",
  "messageFocusIndicatorEnabled": true,
  "messageFocusIndicatorChar": ">",
  "messageFocusIndicatorColor": null,
  "messageFocusBackgroundColor": null,
  "themeOverrides": {},
  "useTeamsPresence": true,
  "forceAvailableWhenFocused": true,
  "realtimeEnabled": false,
  "notifyMuted": false,
  "notifyChatMessages": true,
  "notifyActiveBanner": false,
  "quietHoursStart": null,
  "quietHoursEnd": null,
  "logFile": null,
  "tailEvents": false,
  "tailNetwork": false,
  "tailDiagnostics": false,
  "selfMessagesOnRight": false,
  "scrollOnNewMessages": true,
  "enterSends": false,
  "chatListSort": "recent",
  "chatListGroupByType": false,
  "chatListSectionCap": true,
  "inlineImages": "auto",
  "inlineImageMaxRows": 10,
  "statusBarPosition": "bottom",
  "chatRoutingByAccount": {},
  "chatListCollapsedSections": {}
}
```

<!-- prettier-ignore-start -->

| Key                            | Values               | Default | Description                                                                              |
| ------------------------------ | -------------------- | ------: | ---------------------------------------------------------------------------------------- |
| `theme`                        | `auto`, `dark`, `light`, or a custom name | `dark` | Terminal palette + layout preset. `auto` isn't a theme of its own: it picks `light` or `dark` to match the terminal's background color (asked at startup), falling back to the macOS appearance when the terminal doesn't say; a later macOS appearance switch flips it too. Custom names load `~/.config/teaminal/themes/<name>.json` (see [Themes](#themes) below). |
| `accounts`                     | string array         |    `[]` | owa-piggy profile aliases managed by Accounts.                                           |
| `activeAccount`                | string or null       |  `null` | Default profile alias used at startup when `--profile` is not passed.                    |
| `chatListShortNames`           | boolean              | `false` | Show first names in chat list rows.                                                      |
| `chatListPreviewLines`         | 0–3                  |     `1` | Last-message preview lines under each chat list row (0 = off). Shorter previews use fewer lines. Replaces `showMessagePreviews` (`false` reads as 0). |
| `messagePaneShortNames`        | boolean              |  `true` | Show first names in the message-pane sender column.                                      |
| `showChatNameHeader`           | boolean              | `false` | Show the conversation name (1:1 partner, group chat, or team · # channel) above the messages. |
| `showPresenceInList`           | boolean              |  `true` | Show presence dots in the chat list when available.                                      |
| `showTimestampsInPane` | `off`, `on`, `transient` | `on` | Message timestamps in the message pane. `transient` shows one only when a message comes 15 minutes or more after the previous one. `true` / `false` still read as `on` / `off`. |
| `centerDateMarkers` | boolean | `false` | Center the day separators ("Today", "Fri, May 15") in the message pane. Also in the menu as **Messages → Center dates**. |
| `messageAvatars` | `off`, `small`, `medium`, `large` | `off` | Profile pictures beside other people's messages, 1 / 2 / 3 rows tall, on the first message of each run from the same sender. Needs a terminal with the kitty graphics protocol (kitty, Ghostty, WezTerm) and a Graph account. Also in the menu as **Messages → Profile pictures**. |
| `chatListThumbnails` | `off`, `small`, `medium`, `large` | `off` | Pictures in the chat list, 1 / 2 / 3 rows tall: the other person's photo for 1:1 chats, the team picture for teams and channels. Group and meeting chats show a group / calendar icon at the same size. Without a photo (none set, or no Graph access) the person's initials show. Same terminal and account needs as `messageAvatars`. Also in the menu as **Chat list → Thumbnails**. |
| `showSenderNamesInPane` | boolean | `true` | Show the sender name above each message. Off leaves only the timestamp (or nothing, with timestamps off); tell senders apart by color. Also in the menu as **Messages → Sender names**. |
| `showOwnNameInPane` | boolean | `true` | Show your name above your own messages. Turn off alongside `selfMessagesOnRight`. Also in the menu as **Messages → My name on my messages**. |
| `showReactions`                | `off`, `current`, `all` | `current` | Show message reactions never, only on the focused message, or on every message.      |
| `messageFocusIndicatorEnabled` | boolean              |  `true` | Show the focused-message marker while navigating messages.                               |
| `messageFocusIndicatorChar`    | single character     |     `>` | Marker shown beside the focused message.                                                 |
| `messageFocusIndicatorColor`   | color or null        |  `null` | Override focused-message marker color.                                                   |
| `messageFocusBackgroundColor`  | color or null        |  `null` | Optional focused-message background color.                                               |
| `themeOverrides`               | object               |    `{}` | Override color roles such as `text`, `mutedText`, `unread`, `timestamp`, `presence`, plus `layout` (paddings), `borders` (border styles for `panel`, `modal`, and the `active` pane, which is drawn in `borderActive`), `emphasis` (per-role bold flags), and `fontSize` (per-element text size in percent, kitty text sizing protocol only). Colors under `dark` / `light` apply only to that base theme (the theme editor writes there); top-level colors apply to every theme. |
| `useTeamsPresence`             | boolean              |  `true` | Use the Teams unified presence endpoint (`presence.teams.microsoft.com`) for own presence. Falls back to Graph `/me/presence` automatically on 401/403/404. Set to `false` to force Graph-only in tenants that block public-client access to that host. |
| `forceAvailableWhenFocused`    | boolean              |  `true` | While the terminal window has focus (DEC focus reporting; CSI ?1004), PUT `forceavailability=Available` to `presence.teams.microsoft.com` so Teams shows you Available, like the desktop client does for an active window. The override expires server-side after ~5 min and is refreshed inside that window. Set to `false` to leave presence to Teams' own desktop client / inactivity timer. |
| `realtimeEnabled`              | boolean              | `false` | Enables the experimental Teams trouter push transport for typing, read-receipt, presence, and immediate refresh signals. Polling remains the source of truth and fallback. |
| `notifyMuted`                  | boolean              | `false` | Suppress desktop notification banners while keeping terminal bells.                      |
| `notifyChatMessages`           | boolean              |  `true` | Notify on every new 1:1 / group chat message, not just @mentions. Meeting chats and channels stay mention-only. |
| `notifyActiveBanner`           | boolean              | `false` | Show banners even for the conversation currently open in a focused terminal.             |
| `quietHoursStart`              | `HH:MM` or null      |  `null` | Quiet-hours start time; disabled unless both start and end are set.                      |
| `quietHoursEnd`                | `HH:MM` or null      |  `null` | Quiet-hours end time; windows can cross midnight.                                        |
| `logFile`                      | string or null       |  `null` | Append a redacted event log mirror to this path. CLI `--log-file` overrides it.          |
| `tailEvents`                   | boolean              | `false` | Show an always-on event-log tail panel above the composer.                               |
| `tailNetwork`                  | boolean              | `false` | Show an always-on network-log tail panel above the composer.                             |
| `tailDiagnostics`              | boolean              | `false` | Show an always-on diagnostics tail panel above the composer.                             |
| `selfMessagesOnRight`          | boolean              | `false` | When `true`, your own messages are right-aligned in the message pane (body on the right, sender/timestamp on the left of the body). Other users' messages remain left-aligned. |
| `scrollOnNewMessages`          | boolean              |  `true` | Jump to a new message when it arrives in the open conversation. `false` keeps the cursor where it is. Also in the menu as **Scroll on new messages**. |
| `enterSends` | boolean | `false` | Flip the composer keys: Enter sends, Shift+Enter / Ctrl+Enter / Ctrl+J insert a newline. Only takes effect (and only shown in the menu, as **Enter sends**) in terminals with the kitty keyboard protocol, since elsewhere Shift+Enter is indistinguishable from Enter. |
| `inlineImages`                 | `auto`, `off`        |  `auto` | `auto` renders message images inline in Kitty-compatible terminals, bounded to `inlineImageMaxRows` tall and the width of the message pane, so an image never overlaps neighbouring messages. `off` — and any terminal without Kitty graphics — renders one focusable `[img] name` row per image instead, reserving no picture rows. Space opens the focused image either way. |
| `inlineImageMaxRows`           | integer 1-50         |    `10` | Maximum terminal rows reserved for a single inline image.                                |
| `statusBarPosition`            | `bottom`, `hidden`   | `bottom` | Where the status bar renders. `hidden` suppresses it entirely, freeing one row of vertical space in the message pane. |
| `chatRoutingByAccount`         | object               |    `{}` | Per-account chat transport mode: `graph+ic3`, `ic3+graph`, `ic3-only`, or `graph-only`. |
| `chatListSort`                 | `recent`, `alphabetical` | `recent` | Order of chat rows in the sidebar. `recent` follows last-message time; `alphabetical` sorts by the displayed name. |
| `chatListGroupByType`          | boolean              | `false` | Group sidebar chats under `Direct` / `Groups` / `Meetings` / `Other` headings. Each group shows at most 10 chats, with a `… N more` row to reveal the rest, so one busy type can't push teams and channels off the pane (turn off with `chatListSectionCap`). Headings are collapsible with `h` / `l`. |
| `chatListSectionCap`           | boolean              | `true`  | With grouping on, cap each group at 10 chats behind a `… N more` row. `false` lists every chat. |
| `headerElements`               | object               | all `true` | Per-segment visibility for the header bar. Keys: `app`, `user`, `presence`, `graph`, `chats`, `unread`, `push`, `updated`. Omitted keys keep their default. |
| `headerUserFormat`             | `full`, `tenant`     |  `full` | Header identity format: `full` shows `user (tenant)`, `tenant` shows the tenant only. |
| `statusBarShowKeyHints`        | boolean              |  `true` | Show the keybinding hints line in the status bar. |
| `headerBarCentered`            | boolean              | `false` | Center the header bar segments. Off keeps them left-aligned. |
| `chatListCollapsedSections`    | object               |    `{}` | Collapsed sidebar headers, keyed by section (`oneOnOne`, `group`, `meeting`, `other`, `teams`) or `team:<id>`. Maintained by `h`/`l` in the list; a collapsed header hides its rows and shows `▸` plus the hidden count. |
| `chatListWidth`                | integer or null      |  `null` | Explicit chat-list panel width in columns. `null` = automatic (~28% of terminal, clamped 18–60). Adjusted interactively with Ctrl-X resize mode. |
| `composerHeight`               | integer or null      |  `null` | Explicit composer height in rows. `null` = automatic (from draft line count, clamped 3–10). Adjusted interactively with Ctrl-X resize mode. |

<!-- prettier-ignore-end -->

### Themes

The four built-in themes (`dark`, `light`, `compact`, `comfortable`)
live inside teaminal. `compact` and `comfortable` inherit the `dark`
color palette but tighten or loosen paddings.

**Presets.** Settings → Theme presets (or `p` in the theme editor) lists
the built-in themes and your saved presets:

| Key           | Action                                                                      |
| ------------- | --------------------------------------------------------------------------- |
| Enter / Space | Load the selected theme.                                                    |
| `s`           | Save the current look into the active preset (a built-in asks for a name).  |
| `n`           | Save as a new preset: type a name, Enter.                                   |
| `d`, then `y` | Delete the selected preset. Deleting the active one falls back to its base. |
| Esc           | Back.                                                                       |

In the theme editor, `s` saves and `S` saves as. Edits made in the editor
(the dots) are unsaved until you save them into a preset, which folds them
into the file and clears them. Loading a preset keeps any unsaved edits on
top, like any other theme switch.

A preset also saves the look-related Settings menu toggles under
`"settings"`: status bar and header options, chat list options (sort,
grouping, short names, preview lines, presence dots) and message options
(chat name header, short names, timestamps, sender names, reactions,
images, right-aligned own messages, focus marker, centered dates), and the
profile pictures and chat list thumbnails sizes. Loading the preset
applies them. Built-in themes carry none, so switching to one leaves them
as they are. Behavior settings (notifications, presence, scrolling, Enter
sends) are not part of a preset.

Presets are JSON files at `~/.config/teaminal/themes/<name>.json`; you can
also write one by hand and set `"theme": "<name>"` in `config.json`. The
file is a partial theme layered on its `base` (`dark` when absent); any
subset of these keys is accepted:

```jsonc
{
  "base": "light", // built-in palette underneath: "dark" (default) or "light"
  // Color roles (named color or `#rrggbb`):
  "appBackground": "#001100", // whole app; null = terminal background
  "modalBackground": "#002200", // menus / modals; null = terminal background
  "text": "white",
  "border": "#444",
  "borderActive": "magentaBright",
  "selected": "magenta",
  "unread": "yellow",
  "dateMarker": "gray", // day separator ("Today", "Fri, May 15")
  "senderMessage": null, // other people's message text; null = terminal text color
  "senderMessageBackground": null, // background behind other people's messages
  "chatListPreviewText": null, // chat list last-message preview (read chats); null = muted text
  // Per-presence colors:
  "presence": { "Available": "greenBright", "DoNotDisturb": "red" },
  // Paddings / margins (non-negative integers):
  "layout": {
    "modalPaddingX": 3,
    "modalPaddingY": 1,
    "paneHeaderPaddingLeft": 1, // message body indent
    "senderIndent": 1, // sender name + timestamp indent
    "paneHeaderMarginBottom": 1, // message gap; 0.5 steps give half-row gaps in kitty
    "chatListIndent": 1, // columns between the presence dot and the chat name
    "chatListGap": 0, // blank rows between chats in the list
    "textBackgroundPaddingX": 0, // bg-colored columns around focused / own message bodies
    "textBackgroundPaddingY": 0, // bg-colored rows above / below them
    "textBackgroundRadius": 0, // 1 = rounded "speech bubble" corners on message backgrounds
    "avatarIndent": 0, // columns before the profile picture in conversations
    "dateMarkerIndent": 0, // extra indent of the day separator ("Today")
    "messageMaxWidth": 100, // conversation column width, % of the pane, centered (10-100, steps of 10)
  },
  // Border styles (none | single | double | round | bold | classic | singleDouble | doubleSingle | arrow):
  "borders": { "panel": "single", "modal": "double", "active": "bold" },
  // Per-role bold (true/false):
  "emphasis": {
    "modalTitleBold": true,
    "sectionHeadingBold": true,
    "selectedBold": true,
    "focusedBold": true, // focused message body
    "dateMarkerBold": true, // day separator ("Today", "Fri, May 15")
    "unreadBold": true,
    "senderBold": true,
    "inlineKeyBold": true,
  },
  // Per-element font size, percent of the terminal font (50-100, steps of 10).
  // Needs the kitty text sizing protocol (kitty 0.40+); other terminals ignore it.
  "fontSize": {
    "paneHeader": 100,
    "sender": 100,
    "timestamp": 70,
    "messageText": 100,
    "chatListHeader": 100,
    "chatListName": 100,
    "chatListPreview": 80,
    "dateMarker": 100,
    // Pack shrunk one-line text (all but messageText) to the smaller letter
    // pitch; the cells saved become blank space at the end of the text.
    "tightSpacing": true,
  },
}
```

`themeOverrides` in `config.json` still wins over the theme file, so
you can ship a base theme and tweak per-machine. Color overrides nested
under `themeOverrides.dark` / `themeOverrides.light` apply only to that
base, so the in-app theme editor's tweaks don't follow you across a
dark/light/auto switch; top-level color overrides apply to every theme. Unknown keys, bad
colors, and out-of-range values are dropped with a warning at startup.

The in-app Settings menu persists changes back to `config.json`.

## Keybindings

| Keys                   | When               | Action                                                                                                                                                                           |
| ---------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `j` / Down             | list               | Move cursor down.                                                                                                                                                                |
| `k` / Up               | list               | Move cursor up.                                                                                                                                                                  |
| `u` / PageUp           | list               | Move up half a page.                                                                                                                                                             |
| `d` / PageDown         | list               | Move down half a page.                                                                                                                                                           |
| Enter                  | list               | Open selected chat or channel.                                                                                                                                                   |
| Tab                    | chat / channel     | Toggle between message navigation and composer.                                                                                                                                  |
| Tab                    | composer           | Return to message navigation.                                                                                                                                                    |
| Esc                    | composer / filter  | Leave mode.                                                                                                                                                                      |
| Esc                    | anywhere else      | Toggle the menu overlay. Use `h` / Left to step back a pane.                                                                                                                     |
| Enter / Space          | menu               | Activate the selected menu item (also in submenus).                                                                                                                              |
| ← / →                  | menu               | Step the selected setting's value backwards / forwards (Theme also cycles saved presets); → opens a submenu.                                                                     |
| PgUp / PgDn, `u` / `d` | menu, theme editor | Move half a page up / down.                                                                                                                                                      |
| Ctrl+O                 | menu               | Open the settings file in `$VISUAL` (or `$EDITOR`); reloads on exit.                                                                                                             |
| Ctrl+T                 | menu               | Open the theme file (config.json for built-in themes) the same way.                                                                                                              |
| Ctrl+Enter             | composer           | Send message (or save an edit) in terminals with the kitty keyboard protocol (detected at startup). Ctrl+J also sends, in every terminal; Alt+Enter where Alt/Option sends Meta. |
| Enter                  | composer           | Insert newline.                                                                                                                                                                  |
| `/`                    | list               | Filter chats.                                                                                                                                                                    |
| `n`                    | list               | Open the new-chat prompt.                                                                                                                                                        |
| `m`                    | list               | Toggle the focused chat read/unread.                                                                                                                                             |
| `h` / Left             | list               | Collapse the focused row's section (chat type, team, or all Teams).                                                                                                              |
| `l` / Right            | list               | Expand the focused collapsed section, or show a section's hidden chats.                                                                                                          |
| `a`                    | Accounts           | Find valid `owa-piggy status` profiles to add.                                                                                                                                   |
| `d` / Delete           | Accounts           | Remove the focused account from teaminal's list.                                                                                                                                 |
| `t`                    | Accounts           | Cycle the focused account's chat routing mode.                                                                                                                                   |
| `h` / Left             | chat / channel     | Return to chat list.                                                                                                                                                             |
| `j` / Down             | chat / channel     | Focus next message.                                                                                                                                                              |
| `k` / Up               | chat / channel     | Focus previous message, or load older when focused at the top.                                                                                                                   |
| `gg` / `G`             | chat / channel     | Jump to the oldest loaded / latest message.                                                                                                                                      |
| `u` / PageUp           | chat / channel     | Move up half a page, or load older if that reaches the top.                                                                                                                      |
| `d` / PageDown         | chat / channel     | Move down half a page.                                                                                                                                                           |
| `t`                    | channel            | Open the thread for the focused channel message.                                                                                                                                 |
| Space / `l`            | channel            | Open the thread when `j`/`k` has focused a message's `N replies` badge.                                                                                                          |
| `/`                    | chat / channel     | Search messages in the open conversation.                                                                                                                                        |
| Ctrl+A                 | any                | Open notifications (also in the Esc menu).                                                                                                                                       |
| Ctrl+X                 | list               | Enter resize mode (h/l chat list, j/k composer, 0 reset, Esc done).                                                                                                              |
| Ctrl+B                 | list / chat        | Hide/show the chat list; list and chat then share one pane (h / l).                                                                                                              |
| `?`                    | list               | Show keybindings.                                                                                                                                                                |
| `r`                    | any                | Refresh now.                                                                                                                                                                     |
| `Shift+R`              | any                | Hard refresh: clear visible data and reload from Graph.                                                                                                                          |
| `q`                    | list / menu        | Quit.                                                                                                                                                                            |
| Ctrl+C                 | any                | Quit.                                                                                                                                                                            |

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

## TUI testing

teaminal uses [`@microsoft/tui-test`](https://github.com/microsoft/tui-test)
to drive the real Ink app through a headless PTY and capture what it renders.
Tests run against a **seeded offline mode** (`TEAMINAL_SEED=fixtures`) so no
Microsoft 365 auth is required.

```bash
# Run all TUI flow tests (text-snapshot regression gate)
bun run tui:shots

# Accept new/changed snapshots (after intentional UI changes)
bun run tui:update

# Replay a failing test from its recorded trace
bun run tui:trace

# List discovered flow test files
bun run tui:flows
```

**What is gated vs. what is just recorded:**

- Text and color `.snap` files (under `__snapshots__/` next to each test) are
  the CI gate — a snapshot mismatch fails the build.
- PNG and SVG renders of each step are uploaded as CI artifacts for human
  and agent review but never gate the build (font/AA differences across
  platforms make pixel-perfect cross-OS image comparison unreliable).

Flow test files live under `scripts/tui-loop/flows/`. Add a new
`*.test.ts` there to cover additional UI flows.

## Contributing

Patches, bug reports, and design feedback welcome. See
[`CONTRIBUTING.md`](./CONTRIBUTING.md) for the setup flow, architecture
rules, test expectations, and the do/don't list. Read
[`AGENTS.md`](./AGENTS.md) before changing anything non-trivial.

## License

[MIT](./LICENSE).
