-- lua/blackbox/tools/workspace.lua
-- Workspace tool implementations. Mirrors editors/vscode/src/tools/impl/workspace.ts.

local json = require('blackbox.util.json')

local M = {}

function M.find_file(args)
    if not args.pattern then return 'Error: glob pattern is required' end
    local max_results = math.max(1, args.maxResults or 20)
    local cwd = vim.fn.getcwd()
    -- vim.fn.globpath returns newline-separated string; with the {list=true}
    -- variant we get a table.
    local matches = vim.fn.globpath(cwd, args.pattern, false, true) or {}
    local results = {}
    for _, p in ipairs(matches) do
        if not p:find('/node_modules/', 1, true) then
            table.insert(results, p)
            if #results >= max_results then break end
        end
    end
    return json.encode_pretty(results)
end

local function severity_label(sev)
    if sev == vim.diagnostic.severity.ERROR then
        return 'error'
    elseif sev == vim.diagnostic.severity.WARN then
        return 'warning'
    elseif sev == vim.diagnostic.severity.INFO then
        return 'info'
    else
        return 'hint'
    end
end

function M.get_diagnostics(args)
    local file_filter = args.file
    local sev_filter = args.severity -- "error" | "warning"
    local min_sev = nil
    if sev_filter == 'error' then
        min_sev = vim.diagnostic.severity.ERROR
    elseif sev_filter == 'warning' then
        min_sev = vim.diagnostic.severity.WARN
    end

    local function diags_for(bufnr)
        local diags = vim.diagnostic.get(bufnr)
        if min_sev then
            local kept = {}
            for _, d in ipairs(diags) do
                if d.severity <= min_sev then table.insert(kept, d) end
            end
            diags = kept
        end
        return diags
    end

    local results = {}
    if file_filter then
        local bufnr = vim.fn.bufnr(file_filter)
        local diags = (bufnr ~= -1) and diags_for(bufnr) or {}
        if #diags > 0 then
            local issues = {}
            for _, d in ipairs(diags) do
                table.insert(issues, {
                    line = d.lnum + 1,
                    severity = severity_label(d.severity),
                    message = d.message,
                    source = d.source,
                })
            end
            table.insert(results, { file = file_filter, issues = issues })
        end
    else
        for _, bufnr in ipairs(vim.api.nvim_list_bufs()) do
            if vim.api.nvim_buf_is_loaded(bufnr) then
                local diags = diags_for(bufnr)
                if #diags > 0 then
                    local issues = {}
                    for _, d in ipairs(diags) do
                        table.insert(issues, {
                            line = d.lnum + 1,
                            severity = severity_label(d.severity),
                            message = d.message,
                            source = d.source,
                        })
                    end
                    table.insert(results, { file = vim.api.nvim_buf_get_name(bufnr), issues = issues })
                end
            end
        end
    end

    if #results == 0 then return 'No diagnostics found' end
    return json.encode_pretty(results)
end

return M
