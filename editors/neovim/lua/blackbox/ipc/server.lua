-- lua/blackbox/ipc/server.lua
-- Per-Neovim Unix-domain socket server. Wire-compatible with the VS Code and
-- JetBrains ports — see editors/vscode/src/ipc/server.ts.

local protocol = require('blackbox.ipc.protocol')

local M = {}

local state = {
    handle = nil, ---@type uv_pipe_t|nil
    socket_path = nil, ---@type string|nil
    clients = {},
}

local function log(msg)
    vim.schedule(function() vim.notify('[blackbox] ' .. msg) end)
end

local function on_client_data(client, registry, chunk)
    client._buffer = (client._buffer or '') .. chunk
    while true do
        local nl = client._buffer:find('\n', 1, true)
        if not nl then return end
        local line = client._buffer:sub(1, nl - 1)
        client._buffer = client._buffer:sub(nl + 1)
        if line ~= '' then
            local ok, req = pcall(protocol.decode, line)
            local response
            if not ok or type(req) ~= 'table' then
                response = { id = '', error = 'invalid json' }
            else
                local tool = req.tool
                local args = req.args or {}
                local id = req.id or ''
                local invoke_ok, result = pcall(registry.invoke, tool, args)
                if invoke_ok then
                    response = { id = id, result = result }
                else
                    response = { id = id, error = tostring(result) }
                end
            end
            client:write(protocol.encode(response) .. '\n')
        end
    end
end

local function on_connection(server, registry)
    return function(err)
        if err then
            log('accept failed: ' .. err)
            return
        end
        local client = vim.uv.new_pipe(false)
        server:accept(client)
        table.insert(state.clients, client)
        client:read_start(function(read_err, chunk)
            if read_err then
                log('read failed: ' .. read_err)
                client:close()
                return
            end
            if chunk then
                vim.schedule(function() on_client_data(client, registry, chunk) end)
            else
                client:close()
            end
        end)
    end
end

---@param socket_path string
---@param registry { invoke: fun(tool:string, args:table):string }
function M.start(socket_path, registry)
    if state.handle then return end
    pcall(vim.fn.delete, socket_path) -- remove stale socket
    local pipe = vim.uv.new_pipe(false)
    local ok, bind_err = pcall(function() pipe:bind(socket_path) end)
    if not ok then
        log('bind failed: ' .. tostring(bind_err))
        pipe:close()
        return
    end
    pipe:listen(128, on_connection(pipe, registry))
    state.handle = pipe
    state.socket_path = socket_path
    log('listening on ' .. socket_path)
end

function M.stop()
    if not state.handle then return end
    for _, c in ipairs(state.clients) do pcall(c.close, c) end
    state.clients = {}
    pcall(state.handle.close, state.handle)
    state.handle = nil
    if state.socket_path then pcall(vim.fn.delete, state.socket_path) end
    state.socket_path = nil
end

function M.is_running() return state.handle ~= nil end

return M
