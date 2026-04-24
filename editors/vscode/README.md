# Blackbox

AI-driven debugging for any language — set breakpoints, start/stop debug sessions, inspect variables, and navigate code via [MCP](https://modelcontextprotocol.io/) tools.

Works with any Debug Adapter Protocol (DAP) compatible debugger: PHP, Node.js, Python, Go, C/C++, Java, and more.

> **Pre-release** — This extension is under active development. Install the pre-release version to get the latest features.

## Features

### Breakpoint Management
- Set, remove, and list breakpoints with conditions and log messages
- Batch operations for multiple breakpoints at once

### Debug Session Control
- Start, stop, restart debug sessions for any language
- Continue, pause, step over, step into, step out
- Language-agnostic — works with any VS Code debug adapter

### Variable Inspection
- Get all variables in the current scope
- Deep inspect nested objects and arrays
- Evaluate arbitrary expressions at breakpoints
- Persistent watch expressions across steps

### Editor & Workspace
- Open files at specific lines
- Find files by glob pattern
- Get diagnostics (errors/warnings) from all language services

## How It Works

Blackbox exposes debugging tools to AI models through two transport paths:

1. **VS Code Chat** — Tools are available as `#tool_name` references in Copilot Chat
2. **MCP Server** — A stdio-based MCP server for external AI clients (Cursor, Claude Desktop, etc.)

## Requirements

- VS Code 1.99.0 or later
- A debug adapter extension for your language (e.g., PHP Debug, Node.js Debugger)

## License

MIT
