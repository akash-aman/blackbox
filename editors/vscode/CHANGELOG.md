# Changelog

All notable changes to the Blackbox VS Code extension. Each version is also a [GitHub Release](https://github.com/akash-aman/blackbox/releases) (tag `vscode-v<version>`) with these notes and the packaged `.vsix`.

Releases are published by pushing a `vscode-v<version>` tag; CI refuses to release a version without an entry here. Changes collect under `## Unreleased`; at release time that heading becomes `## <version> (Pre-release) — <date>` (leave out `(Pre-release)` for a stable release).

## 0.4.1 (Pre-release) — 2026-09-30

- `debug_start` no longer hangs when the editor is waiting on a prompt before starting the debugger (saving unsaved files first because of `debug.saveBeforeStart`, a pre-launch task, a picker). After 20s it returns an explanation, naming any unsaved untitled files, and says to answer the prompt and then call `debug_wait_for_stop`.
- `debug_start` fails at once in a workspace in Restricted Mode, where the editor disables debugging, instead of waiting.

## 0.4.0 (Pre-release) — 2026-09-30

- **New tools:** `debug_set_function_breakpoint`, `debug_toggle_breakpoints` (enable/disable without removing), `debug_run_to_line` (temporary breakpoint, always removed), `debug_list_threads`, `debug_set_variable` (via the adapter's setVariable or setExpression), `debug_get_source_context`.
- `hitCondition` on `debug_set_breakpoint`; `functions` on `debug_remove_breakpoint`; function breakpoints and hit conditions in `debug_list_breakpoints`.
- `threadId` and `frameId` on `debug_evaluate`, `debug_get_variables`, `debug_inspect` and `debug_watch`; `threadId` and `levels` on `debug_get_stack_trace`.
- The result notes when the active debug adapter doesn't support function breakpoints or hit conditions.
- **VS Code chat:** all 31 tools (everything except `ide_*`) are now available as `#` tools; 11 were missing before. Declarations are generated from `schema/tools.json` (`npm run sync:tools`).
- One tool list (`tools/catalog.ts`) feeds both the MCP bridge and VS Code chat, and a contract test keeps MCP, the schema, `package.json` and the catalog identical.
- **Tool descriptions for AI:** every tool description was rewritten to say what it does, when to use it instead of related tools, what it returns and its caveats (e.g. `debug_evaluate` runs code). All 75 parameters now have descriptions with formats and defaults (22 had none). MCP clients and VS Code chat now get the same text.
- **MCP annotations:** every tool has a title and `readOnlyHint` / `destructiveHint` / `idempotentHint`, so clients can tell read-only calls (12 tools) from destructive ones (5).
- The MCP server serves `schema/tools.json` directly and checks arguments against it, so a wrong type fails with a clear message (e.g. `arguments.line must be a number`). `debug_start` accepts any extra launch configuration property.
- `debug_wait_for_stop {next: true}` waits for a new pause while another thread is already paused (e.g. a second PHP request).
- Paused threads are tracked per thread, so `debug_list_threads` marks every paused PHP request, not just the latest.
- The old shared `/tmp/blackbox/` folder is no longer read; windows on 0.2.0 or older need the update to be seen.

## 0.3.0 (Pre-release) — 2026-09-30

- **Several editors:** windows record their editor (VS Code, Cursor, Antigravity, …), version and extension version. `ide_list_windows` shows them, `ide_select_window` accepts `app`, and labels name the editor when several are running.
- **Launch-aware routing:** when the same project is open in several windows, calls go to the window the AI was started from (chat panel or integrated terminal via `BLACKBOX_WINDOW`), then to windows of the launching editor.
- **Per-user IPC directory:** sockets moved to `/tmp/blackbox-<uid>/`, created private and checked for ownership. This fixes the bridge failing for a second user on the same machine, and stops other users planting fake windows. The old `/tmp/blackbox/` is still read for 0.2.0 windows.
- **New tools:** `debug_wait_for_stop`, `debug_get_output` (program output and logpoint messages), `debug_set_exception_breakpoints`.
- `debug_get_output` keeps responses small: entries over 2,000 characters are shortened, a response stays under about 50,000 characters, and `match` filters by text. Adapters such as php-debug with `"log": true` write megabytes of protocol trace to the output.
- **`debug_start {configName}`** starts a launch configuration by name, with all its settings. Launch configurations are now read through VS Code, which also fixes values containing `//` (e.g. URLs) being cut off.
- Step and pause tools report where they stopped; all stepping and inspection tools accept `threadId`. Thread selection prefers the paused thread, which fixes concurrent PHP requests and adapters using thread id 0.
- Commands go to the paused debug session, and `debug_stop` stops the whole session tree (fixes Node/js-debug child sessions).
- Adding or removing breakpoints waits for the debug adapter to confirm, so a following continue can't hit a removed breakpoint.
- `npm test` works again on current VS Code (`@vscode/test-electron` 3.1).

## 0.2.0 (Pre-release) — 2026-09-30

- New MCP tools `ide_list_windows` and `ide_select_window`: an AI session can see every VS Code window, its folders and its debugger state (running, or stopped at file:line), and choose the window it controls.
- Calls no longer fall back silently to the last-focused window. When the window cannot be chosen from the working directory, the call fails with the list of windows so the AI can select one.
- A selected window stays selected across reloads; if it closes, calls fail instead of moving to another window.
- Results name the window (`[window: …]`) when more than one is running.

## 0.1.3 (Pre-release) — 2026-09-28

- Fix "IPC connection failed" when more than one VS Code window is open. Each window now has its own socket under `/tmp/blackbox/`, and closing or reloading one window no longer disconnects the others.
- The MCP server routes each call to the window that owns its working directory, and retries briefly while a window is starting.
- The bridge recreates its socket if the file is deleted.
- Tool failures are now reported as MCP errors, and slow tools such as `debug_start` get longer time limits.

## 0.1.2 (Pre-release) — 2026-05-04

- README: the MCP server configuration example uses `<user>` and `<version>` placeholders, with a filled-in macOS example.

## 0.1.1 (Pre-release) — 2026-04-25

- README: new overview, features section and logo.
- Added a Code of Conduct, contributing guidelines and a security policy.

## 0.1.0 (Pre-release) — 2026-04-24

- Initial pre-release
- 22 MCP tools: breakpoints, session control, stepping, variable inspection, editor navigation, workspace utilities
- Dual transport: VS Code `languageModelTools` + MCP stdio server
- Language-agnostic — works with any DAP-compatible debug adapter
