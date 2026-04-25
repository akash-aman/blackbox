-- lua/blackbox/ipc/protocol.lua
-- Wire format (newline-delimited JSON), identical to:
--   editors/vscode/src/ipc/protocol.ts
--   editors/jetbrains/src/main/kotlin/cx/akash/blackbox/ipc/Protocol.kt
--
--   → { id = "1", tool = "debug_set_breakpoint", args = { file = "...", line = 42 } }
--   ← { id = "1", result = "ok: ...:42" }      -- or { id = "1", error = "..." }

local M = {}

M.LOG_NAME = 'blackbox'

function M.encode(obj) return vim.json.encode(obj) end

function M.decode(str) return vim.json.decode(str) end

return M
