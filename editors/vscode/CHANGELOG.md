# Changelog

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
