-- lua/blackbox/tools/init.lua
-- Tool registry. Single source of truth for dispatch — used by both the IPC
-- server (external MCP clients) and the Lua API (require('blackbox').call).
--
-- Tool names match schema/tools.json and the VS Code / JetBrains ports.

local debug_tools = require('blackbox.tools.debug')
local editor_tools = require('blackbox.tools.editor')
local workspace_tools = require('blackbox.tools.workspace')

local M = {}

---@type table<string, fun(args: table): string>
local handlers = {
    -- Breakpoints
    debug_set_breakpoint = debug_tools.set_breakpoint,
    debug_remove_breakpoint = debug_tools.remove_breakpoint,
    debug_remove_all_breakpoints = debug_tools.remove_all_breakpoints,
    debug_list_breakpoints = debug_tools.list_breakpoints,

    -- Session
    debug_start = debug_tools.start,
    debug_stop = debug_tools.stop,
    debug_restart = debug_tools.restart,

    -- Execution
    debug_continue = debug_tools.continue,
    debug_pause = debug_tools.pause,
    debug_step_over = debug_tools.step_over,
    debug_step_into = debug_tools.step_into,
    debug_step_out = debug_tools.step_out,

    -- Inspection
    debug_evaluate = debug_tools.evaluate,
    debug_get_variables = debug_tools.get_variables,
    debug_get_stack_trace = debug_tools.get_stack_trace,
    debug_get_launch_configs = debug_tools.get_launch_configs,
    debug_inspect = debug_tools.inspect,
    debug_watch = debug_tools.watch,

    -- Editor
    editor_open_file = editor_tools.open_file,
    editor_get_open_files = editor_tools.get_open_files,

    -- Workspace
    workspace_find_file = workspace_tools.find_file,
    workspace_get_diagnostics = workspace_tools.get_diagnostics,
}

--- Invoke a tool by name. Wraps the handler in a coroutine so debug tools
--- (which yield on dap_request) work transparently from synchronous callers.
---@param tool string
---@param args table
---@return string
function M.invoke(tool, args)
    local handler = handlers[tool]
    if not handler then return "Error: unknown tool '" .. tool .. "'" end

    -- Run inside a coroutine so handlers may yield (e.g. dap_request).
    local result
    local co = coroutine.create(function() result = handler(args or {}) end)
    local ok, err = coroutine.resume(co)
    if not ok then return 'Error: ' .. tostring(err) end
    -- If the coroutine yielded (waiting for DAP), block-poll until done.
    -- The DAP callback resumes the coroutine asynchronously; we drive Neovim's
    -- event loop so the callback fires.
    while coroutine.status(co) ~= 'dead' do
        vim.wait(50, function() return coroutine.status(co) == 'dead' end, 10)
    end
    return result or ''
end

function M.has(tool) return handlers[tool] ~= nil end

function M.tool_names()
    local names = {}
    for k in pairs(handlers) do table.insert(names, k) end
    table.sort(names)
    return names
end

return M
