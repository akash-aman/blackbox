-- lua/blackbox/tools/debug.lua
-- Debug tool implementations on top of nvim-dap. Mirrors
-- editors/vscode/src/tools/impl/debug.ts in behavior; output strings match
-- the VS Code port wherever practical.

local json = require('blackbox.util.json')

local M = {}

-- Lazy require so blackbox loads even when nvim-dap is missing; debug
-- tools simply return an error in that case.
local function dap()
    local ok, mod = pcall(require, 'dap')
    if not ok then
        return nil, 'Error: nvim-dap is required for debug tools — install mfussenegger/nvim-dap'
    end
    return mod, nil
end

local function breakpoints_mod()
    local d, err = dap(); if not d then return nil, err end
    return require('dap.breakpoints'), nil
end

-- Synchronous DAP request. Yields the current coroutine until the response
-- arrives, then returns (err, body). Callers MUST run inside coroutine.wrap
-- (the IPC server arranges this for every dispatch).
local function dap_request(session, command, args, timeout_ms)
    local co = coroutine.running()
    if not co then
        error('dap_request must be called from within a coroutine')
    end
    local timer = vim.uv.new_timer()
    local resumed = false
    timer:start(timeout_ms or 10000, 0, function()
        if resumed then return end
        resumed = true
        timer:close()
        coroutine.resume(co, 'timeout after ' .. (timeout_ms or 10000) .. 'ms')
    end)
    session:request(command, args, function(err, body)
        if resumed then return end
        resumed = true
        if not timer:is_closing() then timer:close() end
        coroutine.resume(co, err, body)
    end)
    return coroutine.yield()
end

local function active_session()
    local d, err = dap(); if not d then return nil, err end
    local s = d.session()
    if not s then return nil, 'Error: no active debug session' end
    return s, nil
end

local function ensure_buf(file)
    local bufnr = vim.fn.bufnr(file)
    if bufnr == -1 then
        bufnr = vim.fn.bufadd(file); vim.fn.bufload(bufnr)
    end
    return bufnr
end

-- ───────────────────────────── Breakpoints ─────────────────────────────

function M.set_breakpoint(args)
    local bp, err = breakpoints_mod(); if not bp then return err end
    local specs
    if type(args.breakpoints) == 'table' and #args.breakpoints > 0 then
        specs = args.breakpoints
    else
        if not args.file or not args.line or args.line < 1 then
            return 'skip: invalid — file and line (>= 1) required'
        end
        specs = { { file = args.file, line = args.line, condition = args.condition, logMessage = args.logMessage } }
    end

    local results = {}
    for _, spec in ipairs(specs) do
        if not spec.file or not spec.line or spec.line < 1 then
            table.insert(results, 'skip: invalid — file and line (>= 1) required')
        else
            local bufnr = ensure_buf(spec.file)
            bp.set({ condition = spec.condition, log_message = spec.logMessage }, bufnr, spec.line)
            local line = 'ok: ' .. spec.file .. ':' .. spec.line
            if spec.condition then line = line .. ' (if: ' .. spec.condition .. ')' end
            if spec.logMessage then line = line .. ' (log: ' .. spec.logMessage .. ')' end
            table.insert(results, line)
        end
    end
    return table.concat(results, '\n')
end

function M.remove_breakpoint(args)
    local bp, err = breakpoints_mod(); if not bp then return err end
    local specs
    if type(args.breakpoints) == 'table' and #args.breakpoints > 0 then
        specs = args.breakpoints
    else
        if not args.file or not args.line then
            return 'skip: invalid — file and line required'
        end
        specs = { { file = args.file, line = args.line } }
    end

    local results = {}
    for _, spec in ipairs(specs) do
        local bufnr = vim.fn.bufnr(spec.file)
        local existing = (bufnr ~= -1) and bp.get(bufnr) or nil
        local has_match = false
        if existing then
            for _, e in ipairs(existing[bufnr] or {}) do
                if e.line == spec.line then
                    has_match = true; break
                end
            end
        end
        if not has_match then
            table.insert(results, 'skip: no breakpoint at ' .. spec.file .. ':' .. spec.line)
        else
            bp.remove(bufnr, spec.line)
            table.insert(results, 'ok: removed ' .. spec.file .. ':' .. spec.line)
        end
    end
    return table.concat(results, '\n')
end

function M.remove_all_breakpoints(_)
    local bp, err = breakpoints_mod(); if not bp then return err end
    local all = bp.get()
    local count = 0
    for _, lines in pairs(all) do count = count + #lines end
    if count == 0 then return 'No breakpoints to remove' end
    bp.clear()
    return 'Removed all ' .. count .. ' breakpoint(s)'
end

function M.list_breakpoints(_)
    local bp, err = breakpoints_mod(); if not bp then return err end
    local out = {}
    for bufnr, lines in pairs(bp.get()) do
        local file = vim.api.nvim_buf_get_name(bufnr)
        for _, l in ipairs(lines) do
            table.insert(out, {
                type = 'source',
                file = file,
                line = l.line,
                enabled = true,
                condition = l.condition,
                logMessage = l.logMessage,
            })
        end
    end
    return json.encode_pretty(out)
end

-- ──────────────────────────── Session control ──────────────────────────

function M.start(args)
    local d, err = dap(); if not d then return err end
    if not args.type or not args.request then
        return 'Error: "type" and "request" are required'
    end
    local config = vim.tbl_deep_extend('force', {}, args)
    config.name = args.name or ('Debug (' .. args.type .. ')')
    -- nvim-dap expects an "adapter" key on the config or one to be globally
    -- registered under config.type. We rely on the user having configured
    -- dap.adapters.<type> already.
    d.run(config)
    return 'Debug session "' .. config.name .. '" started (type: ' .. args.type .. ', request: ' .. args.request .. ')'
end

function M.stop(_)
    local d, err = dap(); if not d then return err end
    if not d.session() then return 'No active debug session' end
    local name = d.session().config and d.session().config.name or 'session'
    d.terminate()
    d.close()
    return 'Debug session "' .. name .. '" stopped'
end

function M.restart(_)
    local d, err = dap(); if not d then return err end
    if not d.session() then return 'Error: no active debug session' end
    d.restart()
    return 'Debug session restarted'
end

-- ─────────────────────────── Execution control ─────────────────────────

function M.continue(_)
    local d, err = dap(); if not d then return err end
    if not d.session() then return 'Error: no active debug session' end
    d.continue(); return 'Resumed execution'
end

function M.pause(_)
    local d, err = dap(); if not d then return err end
    if not d.session() then return 'Error: no active debug session' end
    d.pause(); return 'Paused execution'
end

function M.step_over(_)
    local d, err = dap(); if not d then return err end
    if not d.session() then return 'Error: no active debug session' end
    d.step_over(); return 'Stepped over to next line'
end

function M.step_into(_)
    local d, err = dap(); if not d then return err end
    if not d.session() then return 'Error: no active debug session' end
    d.step_into(); return 'Stepped into function'
end

function M.step_out(_)
    local d, err = dap(); if not d then return err end
    if not d.session() then return 'Error: no active debug session' end
    d.step_out(); return 'Stepped out of function'
end

-- ───────────────────────────── Inspection ──────────────────────────────

local function current_frame_id(session)
    local stopped = session.stopped_thread_id
    if not stopped then return nil end
    local err, body = dap_request(session, 'stackTrace', { threadId = stopped, startFrame = 0, levels = 1 })
    if err or not body or not body.stackFrames or #body.stackFrames == 0 then return nil end
    return body.stackFrames[1].id
end

function M.evaluate(args)
    local s, err = active_session(); if not s then return err end
    if not args.expression then return 'Error: expression is required' end
    local frame_id = args.frameId or current_frame_id(s)
    if not frame_id then return 'Error: no stack frames — is the debugger stopped at a breakpoint?' end
    local req_err, body = dap_request(s, 'evaluate',
        { expression = args.expression, frameId = frame_id, context = 'repl' })
    if req_err then return 'Error: ' .. tostring(req_err) end
    return json.encode_pretty({
        expression = args.expression,
        result = body.result,
        type = body.type,
        variablesReference = body.variablesReference,
    })
end

function M.get_variables(args)
    local s, err = active_session(); if not s then return err end
    local ref = args.variablesReference
    if not ref then
        local frame_id = current_frame_id(s)
        if not frame_id then return 'No stack frames — is the debugger stopped at a breakpoint?' end
        local s_err, scopes = dap_request(s, 'scopes', { frameId = frame_id })
        if s_err then return 'Error: ' .. tostring(s_err) end
        local result = {}
        for _, scope in ipairs(scopes.scopes or {}) do
            local v_err, vars = dap_request(s, 'variables', { variablesReference = scope.variablesReference })
            if not v_err then
                local list = vars.variables or {}
                if args.filter then
                    local f = string.lower(args.filter)
                    local filtered = {}
                    for _, v in ipairs(list) do
                        if string.find(string.lower(v.name), f, 1, true) then table.insert(filtered, v) end
                    end
                    list = filtered
                end
                local mapped = {}
                for _, v in ipairs(list) do
                    table.insert(mapped, { name = v.name, value = v.value, type = v.type })
                end
                result[scope.name] = mapped
            end
        end
        return json.encode_pretty(result)
    end
    local v_err, vars = dap_request(s, 'variables', { variablesReference = ref })
    if v_err then return 'Error: ' .. tostring(v_err) end
    local mapped = {}
    for _, v in ipairs(vars.variables or {}) do
        table.insert(mapped, {
            name = v.name,
            value = v.value,
            type = v.type,
            expandable = (v.variablesReference or 0) > 0,
            variablesReference = v.variablesReference,
        })
    end
    return json.encode_pretty(mapped)
end

function M.get_stack_trace(_)
    local s, err = active_session(); if not s then return err end
    local thread = s.stopped_thread_id
    if not thread then return 'No threads' end
    local r_err, body = dap_request(s, 'stackTrace', { threadId = thread, startFrame = 0, levels = 20 })
    if r_err then return 'Error: ' .. tostring(r_err) end
    local frames = {}
    for _, f in ipairs(body.stackFrames or {}) do
        table.insert(frames, {
            id = f.id,
            name = f.name,
            file = (f.source and (f.source.path or f.source.name)) or '(unknown)',
            line = f.line,
        })
    end
    return json.encode_pretty(frames)
end

function M.get_launch_configs(_)
    local d, err = dap(); if not d then return err end
    local out = { dapConfigurations = {}, vscodeLaunchJson = {} }
    for adapter_type, configs in pairs(d.configurations or {}) do
        for _, c in ipairs(configs) do
            table.insert(out.dapConfigurations, vim.tbl_extend('force', { type = adapter_type }, c))
        end
    end
    -- Read .vscode/launch.json for parity with the VS Code port.
    local cwd = vim.fn.getcwd()
    local launch_path = cwd .. '/.vscode/launch.json'
    if vim.fn.filereadable(launch_path) == 1 then
        local raw = table.concat(vim.fn.readfile(launch_path), '\n')
        raw = raw:gsub('//[^\n]*', ''):gsub('/%*.-%*/', '')
        local ok, parsed = pcall(vim.json.decode, raw)
        if ok and parsed and parsed.configurations then
            table.insert(out.vscodeLaunchJson, { folder = cwd, configurations = parsed.configurations })
        end
    end
    return json.encode_pretty(out)
end

local function expand_variable(session, ref, depth, max_depth, max_items)
    if depth >= max_depth or not ref or ref <= 0 then return '...' end
    local err, body = dap_request(session, 'variables', { variablesReference = ref })
    if err then return '<error: ' .. tostring(err) .. '>' end
    local items = body.variables or {}
    local result = {}
    local limit = math.min(#items, max_items)
    for i = 1, limit do
        local v = items[i]
        if v.variablesReference and v.variablesReference > 0 then
            result[v.name] = expand_variable(session, v.variablesReference, depth + 1, max_depth, max_items)
        else
            result[v.name] = v.value
        end
    end
    if #items > max_items then result['...'] = '(' .. (#items - max_items) .. ' more items)' end
    return result
end

function M.inspect(args)
    local s, err = active_session(); if not s then return err end
    if not args.variable then return 'Error: variable expression is required' end
    local depth = math.min(args.depth or 2, 5)
    local max_items = math.min(args.maxItems or 50, 200)
    local frame_id = current_frame_id(s)
    if not frame_id then return 'Error: no stack frames — is the debugger stopped at a breakpoint?' end
    local r_err, body = dap_request(s, 'evaluate', {
        expression = args.variable, frameId = frame_id, context = 'repl',
    })
    if r_err then return 'Error inspecting "' .. args.variable .. '": ' .. tostring(r_err) end
    if body.variablesReference and body.variablesReference > 0 then
        local expanded = expand_variable(s, body.variablesReference, 0, depth, max_items)
        return json.encode_pretty({ variable = args.variable, type = body.type, value = expanded })
    end
    return json.encode_pretty({ variable = args.variable, type = body.type, value = body.result })
end

local watches = {}

function M.watch(args)
    local action = args.action
    local exprs = args.expressions or {}
    if action == 'add' then
        if #exprs == 0 then return 'Error: expressions array required for add' end
        for _, e in ipairs(exprs) do watches[e] = true end
        local count = 0; local list = {}
        for k in pairs(watches) do
            count = count + 1; table.insert(list, k)
        end
        return 'Watching ' .. #exprs .. ' expression(s). Total watches: ' .. count .. '\n' .. table.concat(list, ', ')
    elseif action == 'remove' then
        if #exprs == 0 then return 'Error: expressions array required for remove' end
        for _, e in ipairs(exprs) do watches[e] = nil end
        local count = 0; local list = {}
        for k in pairs(watches) do
            count = count + 1; table.insert(list, k)
        end
        local msg = 'Removed ' .. #exprs .. '. Remaining watches: ' .. count
        if count > 0 then msg = msg .. '\n' .. table.concat(list, ', ') end
        return msg
    elseif action == 'clear' then
        local count = 0; for _ in pairs(watches) do count = count + 1 end
        watches = {}
        return 'Cleared all ' .. count .. ' watch expression(s)'
    elseif action == 'list' then
        local list = {}; for k in pairs(watches) do table.insert(list, k) end
        if #list == 0 then return 'No watch expressions set. Use action="add" first.' end
        local s, err = active_session()
        if not s then
            return 'Watch expressions (' .. #list .. '): ' .. table.concat(list, ', ')
                .. '\n(No active debug session — values not available)'
        end
        local frame_id = current_frame_id(s)
        if not frame_id then return 'Watch expressions set but no stack frame — is the debugger stopped?' end
        local results = {}
        for _, e in ipairs(list) do
            local r_err, body = dap_request(s, 'evaluate', { expression = e, frameId = frame_id, context = 'watch' })
            if r_err then results[e] = '<error: ' .. tostring(r_err) .. '>' else results[e] = body.result end
        end
        return json.encode_pretty(results)
    else
        return 'Error: action must be add, remove, list, or clear'
    end
end

return M
