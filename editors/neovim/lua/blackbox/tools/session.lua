-- Launch configurations and session control on nvim-dap.

local common = require('blackbox.tools.common')

local uv = vim.uv or vim.loop

local M = {}

local START_PROMPT_MS = 20000

-- Launch configurations: each folder's .vscode/launch.json, then
-- nvim-dap's own dap.configurations (per filetype).
local function launch_files()
  local files = {}
  local ok_vscode, vscode = pcall(require, 'dap.ext.vscode')
  for _, folder in ipairs(require('blackbox').folders()) do
    local path = vim.fs.joinpath(folder, '.vscode', 'launch.json')
    if ok_vscode and uv.fs_stat(path) then
      local ok, configs = pcall(vscode.getconfigs, path)
      if ok and configs and #configs > 0 then
        table.insert(files, { folder = folder, configurations = configs })
      end
    end
  end
  for filetype, configs in pairs(common.dap().configurations or {}) do
    if type(configs) == 'table' and #configs > 0 then
      table.insert(files, { folder = 'nvim-dap configurations (' .. filetype .. ')', configurations = configs })
    end
  end
  return files
end

-- Configurations may hold functions (nvim-dap allows them); JSON shows a marker.
local function printable(value)
  if type(value) == 'function' then return '<function>' end
  if type(value) ~= 'table' then return value end
  local copy = {}
  for k, v in pairs(value) do copy[k] = printable(v) end
  return copy
end

function M.launch_configs()
  local files = launch_files()
  if #files == 0 then return 'No launch configurations found (.vscode/launch.json or dap.configurations)' end
  return common.json(printable(files))
end

local function find_config(name, folder)
  local names = {}
  for _, file in ipairs(launch_files()) do
    if not folder or file.folder == folder then
      for _, config in ipairs(file.configurations) do
        if config.name == name then return config end
        table.insert(names, config.name)
      end
    end
  end
  error(('no launch configuration named "%s". Available: %s'):format(
    name, #names > 0 and table.concat(names, ', ') or '(none)'), 0)
end

local function check_adapter(config)
  local dap = common.dap()
  if not dap.adapters[config.type] then
    error(('no nvim-dap adapter for "%s". Install one (e.g. :MasonInstall php-debug-adapter for PHP) '
      .. 'and define dap.adapters.%s'):format(config.type, config.type), 0)
  end
end

-- Starts the session and waits until nvim-dap has one, or explains what is
-- probably holding it up instead of hanging.
local function run_watched(config)
  local dap = common.dap()
  local co = coroutine.running()
  local started = false
  local key = 'blackbox_start_' .. tostring(uv.hrtime())
  -- The adapter answering `initialize` means a session exists (works on
  -- every nvim-dap version; listeners.on_session is newer).
  dap.listeners.after.initialize[key] = function()
    if not started then
      started = true
      vim.schedule(function() coroutine.resume(co) end)
    end
  end
  local timer = uv.new_timer()
  timer:start(START_PROMPT_MS, 0, vim.schedule_wrap(function()
    if not started then
      started = true
      coroutine.resume(co, 'stalled')
    end
  end))
  dap.run(config, { new = true })
  local outcome = coroutine.yield()
  dap.listeners.after.initialize[key] = nil
  timer:stop()
  timer:close()
  if outcome == 'stalled' then
    error(('the debugger has not started after %ds. Check the adapter (:DapShowLog) and any prompt '
      .. 'Neovim is showing; if it starts later, call debug_wait_for_stop rather than starting again.'):format(START_PROMPT_MS / 1000), 0)
  end
end

function M.start(args)
  local config
  if type(args.configName) == 'string' and args.configName ~= '' then
    config = vim.deepcopy(find_config(args.configName, args.folder))
  else
    if not args.type then error('"type" is required (e.g. php, go, python, node), or pass "configName"', 0) end
    if not args.request then error('"request" is required (launch or attach)', 0) end
    config = vim.deepcopy(args)
    config.name = config.name or ('Debug (' .. config.type .. ')')
  end
  check_adapter(config)
  run_watched(config)
  return ('Debug session "%s" started%s'):format(config.name,
    args.configName and ' from its launch configuration' or (' (type: ' .. config.type .. ', request: ' .. config.request .. ')'))
end

function M.stop()
  local session = common.find_session()
  if not session then return 'No active debug session' end
  local root = common.root_session(session)
  local dap = common.dap()
  dap.set_session(root)
  local done, wait = common.counter(1)
  dap.terminate(nil, nil, done)
  wait(5000)
  return 'Debug session "' .. root.config.name .. '" stopped'
end

function M.restart()
  local session = common.find_session()
  if not session then error('no active debug session', 0) end
  local root = common.root_session(session)
  if root.capabilities.supportsRestartRequest then
    common.request(root, 'restart', {})
    return 'Debug session "' .. root.config.name .. '" restarted'
  end
  local dap = common.dap()
  dap.set_session(root)
  dap.restart()
  return 'Debug session "' .. root.config.name .. '" restarted (terminated and started again)'
end

return M
