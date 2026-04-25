-- lua/blackbox/init.lua
-- Public entry point.
--
--   require('blackbox').setup({ socket = '/tmp/blackbox-nvim.sock' })

local server = require('blackbox.ipc.server')
local registry = require('blackbox.tools.init')

local M = {}

---@class BlackboxConfig
---@field socket string?  Absolute path to the Unix-domain socket (default: /tmp/blackbox-nvim.sock)
---@field auto_start boolean?  Start the IPC server during setup (default: true)

---@param opts BlackboxConfig?
function M.setup(opts)
    opts = opts or {}
    M.config = {
        socket = opts.socket or '/tmp/blackbox-nvim.sock',
        auto_start = opts.auto_start ~= false,
    }
    if M.config.auto_start then
        server.start(M.config.socket, registry)
    end
end

--- Manually invoke a tool by name. Used by :BlackboxToolCall and tests.
---@param tool string
---@param args table?
---@return string
function M.call(tool, args)
    return registry.invoke(tool, args or {})
end

function M.status()
    return {
        socket = M.config and M.config.socket or '<not started>',
        running = server.is_running(),
        tools = registry.tool_names(),
        dap = (function()
            local ok = pcall(require, 'dap'); return ok
        end)(),
    }
end

function M.shutdown()
    server.stop()
end

return M
