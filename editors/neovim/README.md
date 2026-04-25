# Blackbox — Neovim Plugin

> **Status**: Scaffolded — buildable, all tools wired. See the architecture overview in [docs/implementation-plan.md](../../docs/implementation-plan.md#4-neovim-plugin--implementation-plan).

Neovim plugin implementing the Blackbox tool contract.

## Install

Lazy.nvim:

```lua
{
  'akash-aman/blackbox',
  dependencies = { 'mfussenegger/nvim-dap' },
  config = function()
    require('blackbox').setup({
      socket = '/tmp/blackbox-nvim.sock',
    })
  end,
}
```

External MCP clients then point at the shared bridge:

```bash
BLACKBOX_SOCKET=/tmp/blackbox-nvim.sock \
  node ~/.local/share/nvim/lazy/blackbox/editors/_shared/mcp-bridge/src/server.js
```

For Claude Desktop / Cursor / JetBrains AI Assistant, add an `mcpServers` entry pointing at that command. See [editors/_shared/mcp-bridge/README.md](../_shared/mcp-bridge/README.md).

## How it works

- [plugin/blackbox.lua](plugin/blackbox.lua) registers `:BlackboxStatus` and `:BlackboxToolCall` and a `VimLeavePre` cleanup autocmd.
- [lua/blackbox/init.lua](lua/blackbox/init.lua) exposes `setup()`, `call()`, `status()`, `shutdown()`.
- [lua/blackbox/ipc/server.lua](lua/blackbox/ipc/server.lua) opens a libuv (`vim.uv`) Unix-domain socket and reads NDJSON requests in the same wire format as the VS Code and JetBrains ports.
- Every request is dispatched through [lua/blackbox/tools/init.lua](lua/blackbox/tools/init.lua), which wraps the handler in a coroutine so debug tools may yield while waiting for `nvim-dap` `session:request` callbacks.
- All 22 tools from [schema/tools.json](../../schema/tools.json) are implemented across [debug.lua](lua/blackbox/tools/debug.lua), [editor.lua](lua/blackbox/tools/editor.lua), and [workspace.lua](lua/blackbox/tools/workspace.lua).

## Commands

| Command | Description |
|---------|-------------|
| `:BlackboxStatus` | Print IPC socket path, running state, tool list, nvim-dap availability. |
| `:BlackboxToolCall <tool> <jsonArgs>` | Manually invoke a tool. Useful for testing the bridge end-to-end. |

## Test

Plenary tests verify that every tool in `schema/tools.json` has a handler:

```bash
cd editors/neovim
git clone --depth=1 https://github.com/nvim-lua/plenary.nvim tests/.deps/plenary.nvim
nvim --headless --noplugin -u tests/minimal_init.lua \
  -c "PlenaryBustedDirectory tests/"
```

## Tool Contract

All tools must match the schemas defined in [schema/tools.json](../../schema/tools.json). The registry enforces this via [tests/registry_spec.lua](tests/registry_spec.lua).
