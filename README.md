# Blackbox

AI-driven debugging for any language — set breakpoints, start/stop debug sessions, inspect variables, and navigate code via [MCP](https://modelcontextprotocol.io/) tools.

Works with any Debug Adapter Protocol (DAP) compatible debugger: PHP, Node.js, Python, Go, C/C++, Java, and more.

## IDE Support

| IDE | Status | Directory |
|-----|--------|-----------|
| **VS Code** | Active | [`editors/vscode/`](editors/vscode/) |
| **JetBrains** | Planned | [`editors/jetbrains/`](editors/jetbrains/) |
| **Neovim** | Planned | [`editors/neovim/`](editors/neovim/) |

## Tool Contract

All IDE implementations expose the same set of tools defined in [`schema/tools.json`](schema/tools.json):

- **Breakpoints** — set, remove, list breakpoints
- **Session** — start, stop, restart debug sessions
- **Execution** — continue, pause, step over/into/out
- **Inspection** — evaluate expressions, get variables, stack trace, deep inspect, watch
- **Editor** — open files, list open tabs
- **Workspace** — find files, get diagnostics

## Quick Start (VS Code)

```bash
cd editors/vscode
npm install
npm run compile
```

Then press `F5` in VS Code to launch the extension in development mode.

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for the full architecture overview.

## License

MIT
