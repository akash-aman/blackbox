# Changelog

## 0.3.0 (Pre-release)

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

## 0.2.0 (Pre-release)

- New MCP tools `ide_list_windows` and `ide_select_window`: an AI session can see every VS Code window, its folders and its debugger state (running, or stopped at file:line), and choose the window it controls.
- Calls no longer fall back silently to the last-focused window. When the window cannot be chosen from the working directory, the call fails with the list of windows so the AI can select one.
- A selected window stays selected across reloads; if it closes, calls fail instead of moving to another window.
- Results name the window (`[window: …]`) when more than one is running.

## 0.1.3 (Pre-release)

- Fix "IPC connection failed" when more than one VS Code window is open. Each window now has its own socket under `/tmp/blackbox/`, and closing or reloading one window no longer disconnects the others.
- The MCP server routes each call to the window that owns its working directory, and retries briefly while a window is starting.
- The bridge recreates its socket if the file is deleted.
- Tool failures are now reported as MCP errors, and slow tools such as `debug_start` get longer time limits.

## 0.1.0 (Pre-release)

- Initial pre-release
- 22 MCP tools: breakpoints, session control, stepping, variable inspection, editor navigation, workspace utilities
- Dual transport: VS Code `languageModelTools` + MCP stdio server
- Language-agnostic — works with any DAP-compatible debug adapter
