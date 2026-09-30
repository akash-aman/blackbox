<div align="center">

# ⬛ Blackbox

**AI-driven debugging for any language — set breakpoints, start/stop debug sessions, inspect variables, and navigate code via [MCP](https://modelcontextprotocol.io/) tools.**

</div>

<p align="center">
<a href="https://www.patreon.com/akashaman">
<img src="https://img.shields.io/badge/Patreon-Support-F96854?style=for-the-badge&logo=patreon" alt="Patreon"/>
</a>
<a href="https://www.buymeacoffee.com/akashaman">
<img src="https://img.shields.io/badge/Buy%20Me%20A%20Coffee-Donate-FFDD00?style=for-the-badge&logo=buy-me-a-coffee" alt="Buy Me A Coffee"/>
</a>
<a href="mailto:sir.akashaman@gmail.com">
<img src="https://img.shields.io/badge/Hire%20Me-Email-blue?style=for-the-badge&logo=gmail" alt="Hire Me"/>
</a>
</p>

## Overview

[Blackbox](https://blackbox.xcode.cx/) works seamlessly with any Debug Adapter Protocol (DAP) compatible debugger, including PHP, Node.js, Python, Go, C/C++, Java, and more. 

> **Pre-release** — This extension is under active development. Install the pre-release version to get the latest features.

Made with ❤️ by [Akash Aman](https://linktr.ee/akash_aman)

---

<br>

![Blackbox](https://blackbox.xcode.cx/og-image.png)

## ✨ Features

### 🛑 Breakpoint Management
* Set, remove, and list breakpoints with conditions and log messages.
* Batch operations for multiple breakpoints at once.

### 🐞 Debug Session Control
* Start, stop, and restart debug sessions for any language.
* Continue, pause, step over, step into, and step out.
* Language-agnostic — works with any VS Code debug adapter.

### 🔍 Variable Inspection
* Get all variables in the current scope.
* Deep inspect nested objects and arrays.
* Evaluate arbitrary expressions at breakpoints.
* Persistent watch expressions across steps.

### 📁 Editor & Workspace
* Open files at specific lines.
* Find files by glob pattern.
* Get diagnostics (errors/warnings) from all language services.

## ⚙️ How It Works

Blackbox exposes debugging tools to AI models through two transport paths:

1.  **VS Code Chat** — Tools are available as `#tool_name` references in Copilot Chat.
2.  **MCP Server** — A stdio-based MCP server for external AI clients (Cursor, Claude Desktop, etc.).


## 🛠️ MCP Server Configuration

```json
{
  "servers": {
    "blackbox": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/Users/<user>/.vscode/extensions/akash-cx.blackbox-debug-<version>/out/mcp/server.js"
      ]
    }
  }
}
```

- Example: if the user is on MacOS is akashaman and version of blackbox is 0.1.0 then the path will be: 
```json
{
  "servers": {
    "blackbox": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/Users/akashaman/.vscode/extensions/akash-cx.blackbox-debug-0.1.0/out/mcp/server.js"
      ]
    }
  }
}
```

### Multiple VS Code windows

Each VS Code window runs its own Blackbox bridge, and each AI session (Claude CLI, Cursor, …) chooses which window to control:

* **Automatically**: if exactly one window has the folder you started the AI in (or a sub-folder of it) open, or only one window is running, calls go there.
* **Otherwise the AI chooses**: calls fail with a list of windows. The AI then calls `ide_list_windows`, which shows each window's folders and debugger state, and `ide_select_window` (by folder name such as `wpcore.wpx`, path or id). The choice lasts for that AI session and survives window reloads.

To fix the choice in configuration instead, set one of these in the server's `env`:

* `BLACKBOX_WORKSPACE`: a folder to match instead of the working directory.
* `BLACKBOX_SOCKET`: a socket path to always use, e.g. `/tmp/blackbox/<pid>.sock`.

## 📋 Requirements

* **VS Code** 1.99.0 or later.
* A debug adapter extension for your language (e.g., PHP Debug, Node.js Debugger).

## 📝 License

This project is [MIT](./LICENSE) licensed.

---

<div align="center">

[![Patreon](https://img.shields.io/badge/Patreon-Support-F96854?style=for-the-badge&logo=patreon)](https://www.patreon.com/akashaman)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-Donate-FFDD00?style=for-the-badge&logo=buy-me-a-coffee)](https://www.buymeacoffee.com/akashaman)
[![Hire Me](https://img.shields.io/badge/Hire%20Me-Email-blue?style=for-the-badge&logo=gmail)](mailto:sir.akashaman@gmail.com)

### Made with ❤️ by [Akash Aman](https://linktr.ee/akash_aman)

</div>