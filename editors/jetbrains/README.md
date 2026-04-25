# Blackbox — JetBrains Plugin

> **Status**: Scaffolded — buildable, all tools wired. See the architecture overview in [docs/implementation-plan.md](../../docs/implementation-plan.md#3-jetbrains-plugin--implementation-plan).

JetBrains IDE plugin (IntelliJ IDEA, PhpStorm, WebStorm, PyCharm, GoLand, RubyMine, CLion) implementing the Blackbox tool contract.

## Build & run

```bash
cd editors/jetbrains
./gradlew runIde            # launch a sandbox IDE with the plugin
./gradlew buildPlugin       # produce build/distributions/blackbox-0.1.0.zip
./gradlew verifyPlugin      # validate against multiple IDE versions
./gradlew test              # JUnit + IntelliJ test framework
```

## How it works

- A per-project `IpcServer` ([src/main/kotlin/cx/akash/blackbox/ipc/IpcServer.kt](src/main/kotlin/cx/akash/blackbox/ipc/IpcServer.kt)) listens on a Unix-domain socket at `/tmp/blackbox-jetbrains-<projectHash>.sock`.
- Every request is dispatched through the shared [ToolRegistry](src/main/kotlin/cx/akash/blackbox/tools/ToolRegistry.kt) into one of three implementation modules in [src/main/kotlin/cx/akash/blackbox/tools/impl/](src/main/kotlin/cx/akash/blackbox/tools/impl/) — covering all 22 tools from [schema/tools.json](../../schema/tools.json).
- External MCP clients (Cursor, Claude Desktop, JetBrains AI Assistant, Copilot CLI) connect via the shared [Node.js MCP bridge](../_shared/mcp-bridge/) configured with `BLACKBOX_SOCKET=<that path>`.

## Configure an MCP client

After launching the IDE the socket path is logged at startup. To wire it into Claude Desktop:

```jsonc
// ~/Library/Application Support/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "blackbox": {
      "command": "node",
      "args": ["/abs/path/to/blackbox/editors/_shared/mcp-bridge/src/server.js"],
      "env": { "BLACKBOX_SOCKET": "/tmp/blackbox-jetbrains-abc12345.sock" }
    }
  }
}
```

JetBrains AI Assistant, Cursor, and other MCP-aware clients use the same shape.

## Tool → IDE API mapping

The full mapping table is in [docs/implementation-plan.md §3.5](../../docs/implementation-plan.md#35-tool-implementation-notes-kotlin--ide-api). At a glance:

| Category | Backed by |
|----------|-----------|
| Breakpoints | `XBreakpointManager` + `XLineBreakpointType` |
| Session | `RunManager` + `ProgramRunnerUtil` + `XDebugSession` |
| Stepping | `XDebugSession.resume() / pause() / stepOver() / stepInto() / stepOut()` |
| Inspection | `XDebuggerEvaluator`, `XStackFrame.computeChildren`, `XValuePresentation` |
| Editor | `FileEditorManager` + `OpenFileDescriptor` |
| Workspace | `FilenameIndex` + `DaemonCodeAnalyzerImpl.getHighlights` |

## Notable behavioural difference vs. VS Code

`debug_start` — VS Code accepts a free-form DAP launch dict and starts a session anywhere. JetBrains debugging is driven by typed `RunConfiguration`s, so this tool **looks up an existing run configuration by `name`** (or uses the currently selected one). Define your run configuration in *Run > Edit Configurations* first; pass its display name as the `name` argument.

All other tool outputs match the VS Code port byte-for-byte modulo paths.

## Tool Contract

All tools must match the schemas defined in [schema/tools.json](../../schema/tools.json). The `ToolRegistry` enforces this — every entry in `schema/tools.json` must have a corresponding handler.
