// bun test preload (bunfig.toml). Ink/chalk disable color without a TTY, as on
// CI, and uncolored Ink output trims trailing spaces, so render tests that
// check background bars would pass locally and fail there. Pin a color level
// before chalk loads so every environment renders the same.
process.env.FORCE_COLOR ??= '3'
