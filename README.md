# teaminal

Lightweight terminal Microsoft Teams client. Bun + TypeScript + Ink + Microsoft Graph.

Auth is delegated to [`owa-piggy`](https://github.com/damsleth/owa-piggy) via subprocess - teaminal never sees a refresh token.

## Status

Pre-alpha. See `.plans/teaminal.md` for the design contract and `AGENTS.md` for module structure.

## Develop

```bash
bun install
bun run dev
```

## Build

```bash
bun run build
./dist/teaminal
```
