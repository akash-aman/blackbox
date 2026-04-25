# @blackbox/mcp-bridge

Shared stdio MCP server for every Blackbox port (VS Code, JetBrains, Neovim).

It forwards every tool defined in [`schema/tools.json`](../../../schema/tools.json) over a Unix-domain socket using the same NDJSON protocol the VS Code port uses (see [editors/vscode/src/ipc/protocol.ts](../../vscode/src/ipc/protocol.ts)).

## Usage

```bash
BLACKBOX_SOCKET=/tmp/blackbox-jetbrains-abc12345.sock \
  node /path/to/blackbox/editors/_shared/mcp-bridge/src/server.js
```

Plug into any MCP client (Cursor, Claude Desktop, JetBrains AI Assistant, etc.) as an `stdio` transport.

## Wire protocol

```jsonc
// → request
{ "id": "1", "tool": "debug_set_breakpoint", "args": { "file": "...", "line": 42 } }

// ← response
{ "id": "1", "result": "ok: ...:42" }
// or
{ "id": "1", "error": "no active debug session" }
```

The socket path differs per editor:

| Editor | Default path |
|--------|--------------|
| VS Code | `/tmp/blackbox-debug.sock` |
| JetBrains | `/tmp/blackbox-jetbrains-<projectHash>.sock` |
| Neovim | `/tmp/blackbox-nvim.sock` (configurable) |

## Tool registration

`src/server.js` reads the canonical [`schema/tools.json`](../../../schema/tools.json) and registers every entry with the MCP SDK. There is no per-tool boilerplate — the schema is the source of truth.
