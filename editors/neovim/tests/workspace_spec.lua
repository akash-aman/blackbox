-- tests/workspace_spec.lua

describe('blackbox.tools.workspace', function()
    local workspace

    before_each(function()
        package.loaded['blackbox.tools.workspace'] = nil
        workspace = require('blackbox.tools.workspace')
    end)

    it('rejects find_file without a pattern', function()
        local result = workspace.find_file({})
        assert.equals('Error: glob pattern is required', result)
    end)

    it('returns "No diagnostics found" when there are none', function()
        local result = workspace.get_diagnostics({})
        -- In a fresh nvim there will usually be no diagnostics, but plugins
        -- may inject some — accept either branch.
        assert.is_true(result == 'No diagnostics found' or result:sub(1, 1) == '[')
    end)
end)
