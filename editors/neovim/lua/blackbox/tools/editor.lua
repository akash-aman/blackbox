-- lua/blackbox/tools/editor.lua
-- Editor tool implementations. Mirrors editors/vscode/src/tools/impl/editor.ts.

local json = require('blackbox.util.json')

local M = {}

function M.open_file(args)
    if not args.file then return 'Error: file path is required' end
    local ok, err = pcall(function()
        vim.cmd('edit ' .. vim.fn.fnameescape(args.file))
        if args.line and args.line > 0 then
            vim.api.nvim_win_set_cursor(0, { args.line, 0 })
        end
    end)
    if not ok then return 'Error opening file: ' .. tostring(err) end
    return 'Opened ' .. args.file .. (args.line and (':' .. args.line) or '')
end

function M.get_open_files(_)
    local current = vim.api.nvim_get_current_buf()
    local out = {}
    for _, bufnr in ipairs(vim.api.nvim_list_bufs()) do
        if vim.fn.buflisted(bufnr) == 1 and vim.bo[bufnr].buftype == '' then
            local name = vim.api.nvim_buf_get_name(bufnr)
            if name ~= '' then
                table.insert(out, {
                    file = name,
                    active = (bufnr == current),
                    dirty = vim.bo[bufnr].modified,
                })
            end
        end
    end
    return json.encode_pretty(out)
end

return M
