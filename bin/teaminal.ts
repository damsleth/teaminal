#!/usr/bin/env bun

const VERSION = '0.0.0'

const HELP = `teaminal ${VERSION}

  Lightweight terminal Microsoft Teams client.

USAGE
  teaminal [options]

OPTIONS
  --profile <alias>    owa-piggy profile alias (otherwise uses owa-piggy default)
  --debug              enable verbose stderr logging (sets TEAMINAL_DEBUG=1)
  --version            print version and exit
  --help               print this help and exit

ENVIRONMENT
  TEAMINAL_DEBUG       1/0, enables debug logging on stderr
  XDG_CONFIG_HOME      override config dir (default ~/.config)
`

const args = Bun.argv.slice(2)

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(HELP)
  process.exit(0)
}

if (args.includes('--version') || args.includes('-V')) {
  process.stdout.write(`teaminal ${VERSION}\n`)
  process.exit(0)
}

process.stderr.write('teaminal: bootstrap stub. UI shell wires up in build sequence step 9.\n')
process.exit(0)
