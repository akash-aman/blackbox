-- tests/editor_spec.lua

describe('blackbox.tools.editor', function()
    local editor

    before_each(function()
        package.loaded['blackbox.tools.editor'] = nil
        editor = require('blackbox.tools.editor')
    end)

    it('rejects open_file without a path', function()
        local result = editor.open_file({})
        assert.equals('Error: file path is required', result)
    end)

    it('lists the current buffer in get_open_files', function()
        local tmp = vim.fn.tempname()
        vim.fn.writefile({ 'hello world' }, tmp)
        editor.open_file({ file = tmp })
        local raw = editor.get_open_files({})
        -- macOS canonicalizes /var → /private/var; match the basename instead.
        local basename = vim.fn.fnamemodify(tmp, ':t')
        assert.is_true(string.find(raw, basename, 1, true) ~= nil,
            'expected output to contain ' .. basename .. ', got: ' .. raw)
        vim.fn.delete(tmp)
    end)
end)
