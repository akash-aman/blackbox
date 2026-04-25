-- plugin/blackbox.lua
-- Loaded automatically by Neovim. Defers all real work to lua/blackbox so
-- :help blackbox and :Blackbox* commands are available immediately, but
-- the IPC server only starts when the user calls require('blackbox').setup().

if vim.g.loaded_blackbox == 1 then
    return
end
vim.g.loaded_blackbox = 1

-- User commands ------------------------------------------------------------

vim.api.nvim_create_user_command('BlackboxStatus', function()
    local ok, blackbox = pcall(require, 'blackbox')
    if not ok then
        vim.notify('blackbox: module not loaded', vim.log.levels.WARN)
        return
    end
    print(vim.inspect(blackbox.status()))
end, { desc = 'Show Blackbox IPC server status' })

vim.api.nvim_create_user_command('BlackboxToolCall', function(opts)
    local args = vim.fn.split(opts.args, ' ', false)
    local tool = table.remove(args, 1)
    local payload = table.concat(args, ' ')
    local parsed = (payload == '' and {}) or vim.fn.json_decode(payload)
    local result = require('blackbox').call(tool, parsed)
    print(result)
end, {
    nargs = '+',
    desc = 'Manually invoke a Blackbox tool: :BlackboxToolCall <tool> <jsonArgs>',
})

vim.api.nvim_create_autocmd('VimLeavePre', {
    group = vim.api.nvim_create_augroup('BlackboxCleanup', { clear = true }),
    callback = function()
        local ok, blackbox = pcall(require, 'blackbox')
        if ok then blackbox.shutdown() end
    end,
})
