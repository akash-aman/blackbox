# Blackbox — Neovim Plugin

> **Status**: Planned

Neovim plugin implementing the Blackbox tool contract.

## Architecture

- **Language**: Lua
- **Debug**: [`nvim-dap`](https://github.com/mfussenegger/nvim-dap) (DAP client)
- **Editor**: `vim.api.nvim_buf_*`, `vim.fn.bufload`
- **Workspace**: `vim.fn.glob`, `vim.lsp.diagnostic`
- **MCP Transport**: Lua stdio server or Node.js MCP binary

## Dependencies

- Neovim >= 0.9
- `nvim-dap` (required for debug tools)

## Tool Contract

All tools must match the schemas defined in [`/schema/tools.json`](../../schema/tools.json).
