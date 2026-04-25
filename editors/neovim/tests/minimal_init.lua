-- tests/minimal_init.lua
-- Minimal init used by `nvim --headless` test runs.
--
--   nvim --headless -u tests/minimal_init.lua \
--     -c "PlenaryBustedDirectory tests/"

-- Resolve the plugin root (this file lives at tests/minimal_init.lua).
local this_file = debug.getinfo(1, 'S').source:sub(2)
local plugin_root = vim.fn.fnamemodify(this_file, ':p:h:h')
vim.opt.rtp:prepend(plugin_root)

-- plenary is expected on the runtimepath; users typically install via lazy.nvim.
-- For CI, clone it into ./tests/.deps/plenary.nvim and prepend here.
local plenary = plugin_root .. '/tests/.deps/plenary.nvim'
if vim.fn.isdirectory(plenary) == 1 then
    vim.opt.rtp:prepend(plenary)
    -- Source plenary's plugin file so :PlenaryBustedDirectory and friends
    -- become available when nvim is launched with --noplugin.
    vim.cmd('runtime plugin/plenary.vim')
end

-- Disable swapfiles, backups for cleaner test runs.
vim.opt.swapfile = false
vim.opt.backup = false
vim.opt.writebackup = false

require('plenary.busted')
