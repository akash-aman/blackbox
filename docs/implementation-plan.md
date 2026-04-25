# Blackbox — Multi-IDE Implementation Plan

This document captures the result of studying the existing VS Code implementation and translates it into a concrete, file-by-file plan for the **JetBrains** and **Neovim** ports.

---

## 1. How the current VS Code implementation works

### 1.1 The contract
Every IDE port consumes a single source of truth: [`schema/tools.json`](../schema/tools.json). It defines

- The **canonical tool name** (e.g. `debug_set_breakpoint`)
- The **input schema** (JSON Schema)
- The **display name / description** the UI / model sees

If a port deviates from these names or shapes, MCP clients (Cursor, Claude Desktop, Copilot, etc.) cannot talk to it interchangeably.

### 1.2 The dual-path execution model

VS Code exposes the same tools through **two transports** that converge on **one shared implementation**:

```
┌─────────────────────────────────┐    ┌──────────────────────────────┐
│  Native chat (Copilot, etc.)    │    │  External MCP clients        │
│  via vscode.lm.registerTool     │    │  (Cursor / Claude / CLI)     │
└──────────────┬──────────────────┘    └──────────────┬───────────────┘
               │                                       │ stdio (MCP)
               ▼                                       ▼
       tools/*.ts (thin wrappers)           mcp/server.ts (child process)
               │                                       │
               │                                       ▼
               │                            ipc/server.ts (Unix socket
               │                            inside extension host)
               │                                       │
               ▼                                       ▼
                       tools/impl/*  (single source of truth)
                                  │
                                  ▼
                  vscode.debug / vscode.workspace / vscode.window
```

### 1.3 File-by-file map (VS Code)

| Path | Responsibility |
|------|----------------|
| [editors/vscode/src/extension.ts](../editors/vscode/src/extension.ts) | Activation: registers LM tools + starts IPC server |
| [editors/vscode/src/tools/index.ts](../editors/vscode/src/tools/index.ts) | Aggregates tool registrations |
| [editors/vscode/src/tools/debug.ts](../editors/vscode/src/tools/debug.ts) | LM wrapper for debug tools |
| [editors/vscode/src/tools/editor.ts](../editors/vscode/src/tools/editor.ts) | LM wrapper for editor tools |
| [editors/vscode/src/tools/workspace.ts](../editors/vscode/src/tools/workspace.ts) | LM wrapper for workspace tools |
| [editors/vscode/src/tools/impl/debug.ts](../editors/vscode/src/tools/impl/debug.ts) | DAP-level logic (breakpoints, sessions, eval, inspect, watch) |
| [editors/vscode/src/tools/impl/editor.ts](../editors/vscode/src/tools/impl/editor.ts) | `openFile`, `getOpenFiles` |
| [editors/vscode/src/tools/impl/workspace.ts](../editors/vscode/src/tools/impl/workspace.ts) | `findFile`, `getDiagnostics` |
| [editors/vscode/src/ipc/protocol.ts](../editors/vscode/src/ipc/protocol.ts) | `IPCRequest` / `IPCResponse` shape, socket path |
| [editors/vscode/src/ipc/server.ts](../editors/vscode/src/ipc/server.ts) | Unix socket server in extension host |
| [editors/vscode/src/ipc/handlers.ts](../editors/vscode/src/ipc/handlers.ts) | Wires socket messages to `impl/*` |
| [editors/vscode/src/mcp/server.ts](../editors/vscode/src/mcp/server.ts) | MCP stdio server (child process); forwards to socket |

### 1.4 Wire protocol on the socket
Newline-delimited JSON, one message per line:

```jsonc
// → request
{ "id": "1", "tool": "debug_set_breakpoint", "args": { "file": "...", "line": 42 } }
// ← response
{ "id": "1", "result": "ok: ...:42" }   // or { "id": "1", "error": "..." }
```

This protocol is intentionally trivial so any language (Kotlin, Lua) can reproduce both ends.

---

## 2. Cross-port design principles (apply to JetBrains & Neovim)

1. **Reuse the schema verbatim.** Do not redefine names, types or descriptions. At build time, generate registration code from `schema/tools.json` whenever feasible.
2. **Mirror the dual-path model.**
   - **Native path** — register tools through whatever AI surface the editor already exposes (JetBrains MCP Server plugin extension points, Neovim plugin command surface).
   - **External path** — expose the same tools via stdio MCP using the bundled Node.js MCP server (so any external client can talk to the editor).
3. **One implementation file per category** (`debug`, `editor`, `workspace`) — never duplicate logic between the native path and the IPC handler.
4. **Identical IPC wire format** — keep `id` / `tool` / `args` / `result` / `error` exactly the same. Socket path differs per editor (`/tmp/blackbox-<editor>.sock`).
5. **Language-agnostic debug** — always go through the editor's DAP layer (XDebugger for JetBrains, nvim-dap for Neovim). Never write per-language code.
6. **Identical text output** — keep the exact wording of strings VS Code returns (`"ok: file:line"`, `"Error: no active debug session"`, etc.) so AI prompts and tests stay portable.

---

## 3. JetBrains plugin — implementation plan

### 3.1 Stack
| Concern | Choice |
|---------|--------|
| Language | Kotlin |
| Build | Gradle + IntelliJ Platform Gradle Plugin (`org.jetbrains.intellij.platform`) |
| Target IDEs | IntelliJ IDEA, PhpStorm, WebStorm, PyCharm, GoLand, RubyMine, CLion (anything 2024.2+) |
| Native AI surface | [JetBrains MCP Server plugin](https://plugins.jetbrains.com/plugin/26071-mcp-server) extension point `com.intellij.mcpServer.mcpTool` |
| External MCP | Bundled Node.js stdio server (reused from VS Code) |
| Debug | `XDebuggerManager`, `XBreakpointManager`, `XDebugSession`, `XSourcePosition`, `XStackFrame`, `XDebuggerEvaluator` |
| Editor | `FileEditorManager`, `OpenFileDescriptor` |
| Workspace | `FilenameIndex`, `FileTypeIndex`, `ProjectFileIndex` |
| Diagnostics | `DaemonCodeAnalyzerImpl.getHighlights` / `HighlightInfo` |

### 3.2 Directory layout
```
editors/jetbrains/
├── build.gradle.kts
├── settings.gradle.kts
├── gradle.properties
├── README.md
├── src/main/
│   ├── kotlin/cx/akash/blackbox/
│   │   ├── BlackboxPlugin.kt            ← entry point / project listener
│   │   ├── ipc/
│   │   │   ├── Protocol.kt              ← IPCRequest/Response data classes
│   │   │   └── IpcServer.kt             ← Unix-domain socket (Java 16+ UDS)
│   │   ├── mcp/
│   │   │   └── ToolRegistrations.kt     ← registers tools with mcpServer plugin
│   │   ├── tools/
│   │   │   ├── ToolRegistry.kt          ← maps tool name → handler
│   │   │   ├── DebugTools.kt            ← thin wrappers (reads schema)
│   │   │   ├── EditorTools.kt
│   │   │   ├── WorkspaceTools.kt
│   │   │   └── impl/
│   │   │       ├── DebugImpl.kt         ← XDebugger-based shared logic
│   │   │       ├── EditorImpl.kt
│   │   │       └── WorkspaceImpl.kt
│   │   └── util/
│   │       ├── Json.kt                  ← kotlinx.serialization helpers
│   │       └── Threading.kt             ← runReadAction / invokeLater wrappers
│   └── resources/
│       ├── META-INF/
│       │   ├── plugin.xml               ← project listener + mcpServer.mcpTool EPs
│       │   └── pluginIcon.svg
│       └── blackbox-tools.json          ← copy of schema/tools.json (gradle task)
├── mcp-bridge/                          ← reuses the VS Code Node.js MCP server
│   └── README.md
└── src/test/kotlin/...                  ← JUnit5 + IntelliJ test framework
```

### 3.3 Native AI registration
The JetBrains MCP Server plugin auto-discovers any extension that contributes:

```xml
<!-- META-INF/plugin.xml -->
<extensions defaultExtensionNs="com.intellij">
  <postStartupActivity implementation="cx.akash.blackbox.BlackboxStartup"/>
</extensions>

<extensions defaultExtensionNs="com.jetbrains.mcpServer">
  <mcpTool implementation="cx.akash.blackbox.mcp.DebugSetBreakpointTool"/>
  <mcpTool implementation="cx.akash.blackbox.mcp.DebugStartTool"/>
  <!-- … one per tool from schema/tools.json … -->
</extensions>
```

Each `mcpTool` is a Kotlin class implementing
`com.intellij.mcpServer.tools.AbstractMcpTool<Args>`; its `handle()` method delegates to the corresponding `impl/*` function. This gives users the tool *inside* the JetBrains AI Assistant chat.

### 3.4 IPC server
- Use Java 16+ `java.nio.channels.ServerSocketChannel` over `UnixDomainSocketAddress`.
- Path: `/tmp/blackbox-jetbrains-<projectHash>.sock` (one per project to avoid cross-project collision).
- Same NDJSON protocol as VS Code (`Protocol.kt` mirrors `ipc/protocol.ts`).
- Lifetime tied to `Disposable` provided by the project; cleanup unlinks the socket.

### 3.5 Tool implementation notes (Kotlin → IDE API)

| Tool | IntelliJ API |
|------|--------------|
| `debug_set_breakpoint` | `XBreakpointManager.addLineBreakpoint(type, fileUrl, line)` + `setCondition` / `setLogExpression` |
| `debug_remove_breakpoint` | `XBreakpointManager.removeBreakpoint` after lookup by URL+line |
| `debug_list_breakpoints` | `XBreakpointManager.getBreakpoints(XLineBreakpointType.EP_NAME...)` |
| `debug_start` | Build `RunnerAndConfigurationSettings` from generic config; `ProgramRunnerUtil.executeConfiguration` |
| `debug_stop` | `XDebuggerManager.currentSession.stop()` |
| `debug_continue` / `pause` / `step_*` | `XDebugSession.resume()`, `pause()`, `stepOver(false)`, `stepInto()`, `stepOut()` |
| `debug_evaluate` | `currentSession.currentStackFrame?.evaluator?.evaluate(expression, callback, position)` (wrap callback in suspend coroutine) |
| `debug_get_variables` | Walk `XStackFrame.computeChildren(node)`; serialize via `XValuePresentation` |
| `debug_get_stack_trace` | `XExecutionStack.computeStackFrames` |
| `debug_inspect` | Same as `evaluate` + recursive `computeChildren` with depth/maxItems caps |
| `debug_watch` | Local `MutableSet<String>`; on `list`, evaluate each through current evaluator |
| `debug_get_launch_configs` | `RunManager.getInstance(project).allConfigurationsList` filtered to debug-capable |
| `editor_open_file` | `FileEditorManager.openFile(VirtualFile, true)` + `OpenFileDescriptor(project, vFile, line-1, 0).navigate(true)` |
| `editor_get_open_files` | `FileEditorManager.openFiles` + `selectedEditor` |
| `workspace_find_file` | `FilenameIndex.processAllFileNames` + glob via `FileSystemUtil.matches` (or use `WorkspaceFileIndex` + `Glob`) |
| `workspace_get_diagnostics` | `DaemonCodeAnalyzerImpl.getHighlights(document, minSeverity, project)` per open file (or use `MarkupModel`) |

Output strings must match VS Code byte-for-byte where practical.

### 3.6 Threading rules
- All IDE state reads → `ReadAction.compute { ... }`.
- All write/edit operations → `WriteCommandAction.runWriteCommandAction(project) { ... }`.
- Block evaluator/computeChildren callbacks with `kotlinx.coroutines.suspendCancellableCoroutine` so handlers can `await` them.
- IPC handlers run on a background coroutine dispatcher; bounce to EDT only when needed.

### 3.7 Build & ship
- `gradle.properties`: `platformType=IC`, `platformVersion=2024.2`, `pluginSinceBuild=242`.
- Verify against multiple IDEs in CI with `verifyPlugin` task (`platformPlugins=PhpStorm-...,GoLand-...`).
- `runIde` task for local dev.
- Publish to JetBrains Marketplace via `publishPlugin` (token in CI secret).

### 3.8 Test plan
- Unit: per-tool with the IntelliJ heavy/light test fixtures (`BasePlatformTestCase`).
- Integration: launch a Node debug session against a tiny script in `src/test/resources/fixtures` and assert each tool returns the expected JSON.
- Schema: a `SchemaConformanceTest` parses `blackbox-tools.json` and checks every tool name has a registered handler.

---

## 4. Neovim plugin — implementation plan

### 4.1 Stack
| Concern | Choice |
|---------|--------|
| Language | Lua (Neovim ≥ 0.10) |
| Debug | [`nvim-dap`](https://github.com/mfussenegger/nvim-dap) |
| Diagnostics | `vim.diagnostic.get` |
| Files | `vim.fs.dir` / `vim.fn.globpath` |
| External MCP | Bundled Node.js stdio server (reused from VS Code) |
| Native AI surface | Plugin commands + Lua API (`require('blackbox').*`); optional [`mcphub.nvim`](https://github.com/ravitemer/mcphub.nvim) integration |

There is no first-class chat surface inside Neovim itself, so the "native path" is just a public Lua API plus user commands. The "external path" is the canonical entry point that AI clients use.

### 4.2 Directory layout
```
editors/neovim/
├── README.md
├── plugin/
│   └── blackbox.lua                 ← :Blackbox commands, autocmd to start IPC server
├── lua/blackbox/
│   ├── init.lua                     ← public API: setup(), call(tool, args)
│   ├── ipc/
│   │   ├── protocol.lua             ← request/response shape, socket path
│   │   └── server.lua               ← vim.uv.new_pipe() Unix socket
│   ├── tools/
│   │   ├── init.lua                 ← registry: name → handler
│   │   ├── debug.lua                ← wraps nvim-dap
│   │   ├── editor.lua               ← buffer/window ops
│   │   └── workspace.lua            ← diagnostics + file finder
│   └── util/
│       ├── json.lua                 ← vim.json wrappers + safety
│       └── log.lua
├── mcp-bridge/                      ← Node.js stdio MCP server (shared with VS Code)
│   ├── package.json
│   └── server.js
├── doc/
│   └── blackbox.txt                 ← :help blackbox
└── tests/
    ├── minimal_init.lua
    ├── debug_spec.lua
    └── editor_spec.lua              ← plenary.nvim busted-style tests
```

### 4.3 Wire-up
`require('blackbox').setup({ socket = '/tmp/blackbox-nvim.sock' })`:

1. Verifies `nvim-dap` is loadable (warns otherwise — only debug tools become unavailable).
2. Starts a libuv pipe server using `vim.uv.new_pipe(false)` → `bind(socket)` → `listen(128, on_connect)`.
3. Reads NDJSON, dispatches via `tools/init.lua` registry, writes response.
4. Creates an `autocmd` on `VimLeavePre` to `unlink` the socket.

### 4.4 Tool implementation notes (Lua → API)

| Tool | Implementation |
|------|----------------|
| `debug_set_breakpoint` | `require('dap.breakpoints').set({ condition = ..., log_message = ... }, bufnr, line)` (open buffer first via `vim.fn.bufadd` + `bufload`) |
| `debug_remove_breakpoint` | `dap.breakpoints.remove(bufnr, line)` |
| `debug_remove_all_breakpoints` | `dap.breakpoints.clear()` |
| `debug_list_breakpoints` | `dap.breakpoints.get()` → flatten `{bufnr → { {line, condition, log_message}, … }}` |
| `debug_start` | Build adapter+config from args; `dap.run(config)`; if `request == "attach"`, ensure `adapter.port` is set |
| `debug_stop` | `dap.terminate()` (and `dap.close()`) |
| `debug_restart` | `dap.restart()` |
| `debug_continue` / `pause` / `step_*` | `dap.continue()`, `dap.pause()`, `dap.step_over()`, `dap.step_into()`, `dap.step_out()` |
| `debug_evaluate` | `session = dap.session(); session:request('evaluate', { expression = ..., frameId = ..., context = 'repl' }, cb)` wrapped with a coroutine helper |
| `debug_get_variables` | `session:request('stackTrace' → 'scopes' → 'variables', …)` — same DAP traversal as VS Code |
| `debug_get_stack_trace` | `session:request('stackTrace', { threadId = ..., levels = 20 })` |
| `debug_inspect` | Same as `evaluate` + recursive `variables` with depth/maxItems caps |
| `debug_watch` | Module-local `Set` of strings; on `list`, evaluate against current frame |
| `debug_get_launch_configs` | Read `.vscode/launch.json` (strip JSONC comments) AND `dap.configurations` |
| `editor_open_file` | `vim.cmd.edit(vim.fn.fnameescape(file))` then `vim.api.nvim_win_set_cursor(0, {line, 0})` |
| `editor_get_open_files` | Iterate `vim.api.nvim_list_bufs()` filtered by `buflisted` + `buftype == ''`; mark current via `nvim_get_current_buf` |
| `workspace_find_file` | `vim.fn.globpath(cwd, pattern, false, true)` capped to `maxResults` |
| `workspace_get_diagnostics` | `vim.diagnostic.get(bufnr_or_nil)`; map severity (`ERROR=1` → `"error"`, etc.) |

### 4.5 Coroutine helper for DAP requests
nvim-dap's `session:request` is callback-based. Wrap it so handlers can `await`:

```lua
local function dap_request(session, command, args)
  local co = coroutine.running()
  session:request(command, args, function(err, body)
    coroutine.resume(co, err, body)
  end)
  return coroutine.yield()
end
```

All handlers run inside `coroutine.wrap` so the IPC server can resume them when DAP responds.

### 4.6 MCP bridge
Reuse the VS Code Node.js MCP server with an env override:

```bash
BLACKBOX_SOCKET=/tmp/blackbox-nvim.sock node mcp-bridge/server.js
```

`mcp/server.ts` already takes the socket path through a constant; adjust to read from `process.env.BLACKBOX_SOCKET` first. This unifies the MCP layer across VS Code, JetBrains, and Neovim.

### 4.7 User-facing commands (optional but recommended)
- `:BlackboxStatus` — print whether the IPC server is up, current socket, active DAP session.
- `:BlackboxToolCall <tool> <jsonArgs>` — manual invocation for debugging the bridge.

### 4.8 Test plan
- `plenary.nvim` + `busted` style specs.
- Headless runner: `nvim --headless --noplugin -u tests/minimal_init.lua -c "PlenaryBustedDirectory tests/"`.
- Mock `nvim-dap` in the unit layer; run a real session against a Python script in CI integration.

---

## 5. Shared deliverable: extract the MCP bridge

Once a second editor lands, lift the VS Code stdio server out into a stand-alone package:

```
editors/_shared/mcp-bridge/
├── package.json          ← name: "@blackbox/mcp-bridge"
├── src/server.ts         ← reads BLACKBOX_SOCKET env, wires every tool from schema/tools.json
└── codegen/
    └── from-schema.ts    ← generates server.ts entries from schema/tools.json
```

Each editor's package then `npm install`s (or vendors) this binary and points it at its own socket. Result:

- One MCP surface that every IDE inherits.
- Zero drift in tool descriptions / schemas — they are generated.

---

## 6. Execution order

1. Land the JetBrains plugin scaffold (Gradle, plugin.xml, IPC server, no tools yet) — proves the project loads in PhpStorm.
2. Implement debug tools in JetBrains (highest value path).
3. Extract the shared MCP bridge.
4. Land Neovim scaffold (plugin/, IPC server, debug tool subset).
5. Fill in editor + workspace tools for both ports.
6. CI: schema-conformance test that asserts every tool in `schema/tools.json` has a handler in every port.
7. Publish: JetBrains Marketplace + `nvim-dap`-style README install snippet for Neovim.

---

## 7. Definition of done (per port)

- Every tool name from `schema/tools.json` is callable.
- Calling the same tool with the same args produces the same text output (modulo paths) as the VS Code port.
- External MCP clients (tested with `claude --mcp` and Cursor) can list and invoke the tools.
- `verifyPlugin` (JetBrains) / headless plenary tests (Neovim) green in CI.
- README installation snippet works from a clean machine.
