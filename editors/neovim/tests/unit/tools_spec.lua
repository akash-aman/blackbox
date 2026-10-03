-- Breakpoint stores and helpers that don't need a running debug adapter.
local breakpoints = require('blackbox.tools.breakpoints')
local common = require('blackbox.tools.common')

local function run(fn)
  local result, err, finished
  coroutine.wrap(function()
    local ok, r = pcall(fn)
    if ok then result = r else err = r end
    finished = true
  end)()
  vim.wait(2000, function() return finished end, 5)
  if err then error(err, 0) end
  return result
end

describe('breakpoint tools (no session)', function()
  local file
  before_each(function()
    run(breakpoints.remove_all)
    file = vim.fn.tempname() .. '.go'
    vim.fn.writefile({ 'package main', 'func main() {', '  x := 1', '  _ = x', '}' }, file)
  end)

  it('sets, lists, disables, enables and removes source and function breakpoints', function()
    assert.is_truthy(run(function() return breakpoints.set({ file = file, line = 3, hitCondition = '2' }) end):find('ok: '))
    run(function() return breakpoints.set_function({ name = 'main.main' }) end)
    local list = vim.json.decode(run(breakpoints.list))
    assert.equals(2, #list)
    assert.are.same({ 'source', 3, true, '2' }, { list[1].type, list[1].line, list[1].enabled, list[1].hitCondition })
    assert.are.same({ 'function', 'main.main', true }, { list[2].type, list[2].name, list[2].enabled })

    assert.equals('Disabled 2 breakpoint(s)', run(function() return breakpoints.toggle({ enabled = false }) end))
    list = vim.json.decode(run(breakpoints.list))
    assert.is_false(list[1].enabled)
    assert.equals('2', list[1].hitCondition, 'keeps the hit condition while disabled')
    assert.equals(2, breakpoints.extra_count())

    assert.equals('Enabled 1 breakpoint(s)', run(function() return breakpoints.toggle({ enabled = true, breakpoints = { { file = file, line = 3 } } }) end))
    assert.is_true(vim.json.decode(run(breakpoints.list))[1].enabled)

    local removed = run(function() return breakpoints.remove({ file = file, line = 3, functions = { 'main.main', 'nope' } }) end)
    assert.is_truthy(removed:find('ok: removed ' .. vim.pesc(file) .. ':3'))
    assert.is_truthy(removed:find('ok: removed function main.main'))
    assert.is_truthy(removed:find('skip: no function breakpoint on nope'))
    assert.equals('[]', run(breakpoints.list))
  end)

  it('rejects invalid input with plain messages', function()
    assert.is_truthy(run(function() return breakpoints.set({ file = file }) end):find('skip: invalid'))
    assert.has_error(function() run(function() return breakpoints.toggle({}) end) end, '"enabled" (true or false) is required')
    assert.has_error(function() run(function() return breakpoints.set_exception_filters({}) end) end, 'no active debug session')
  end)
end)

describe('helpers', function()
  it('json does not escape slashes and round-trips', function()
    local text = common.json({ p = '/a/b', b = 'x\\/y' })
    assert.equals('{"p":"/a/b","b":"x\\\\/y"}', text:gsub('"b":"x\\\\/y","p":"/a/b"', '"p":"/a/b","b":"x\\\\/y"'))
    assert.are.same({ p = '/a/b', b = 'x\\/y' }, vim.json.decode(text))
  end)

  it('same_file sees through symlinks', function()
    local dir = vim.uv.fs_realpath(vim.fn.tempname():match('(.*)/')) .. '/bbx-link-' .. vim.uv.hrtime()
    vim.fn.mkdir(dir .. '/src', 'p')
    vim.fn.writefile({}, dir .. '/src/index.php')
    vim.uv.fs_symlink(dir .. '/src', dir .. '/wp')
    assert.is_true(common.same_file(dir .. '/wp/index.php', dir .. '/src/index.php'))
    assert.is_false(common.same_file(dir .. '/wp/index.php', dir .. '/src/other.php'))
    vim.fn.delete(dir, 'rf')
  end)
end)
