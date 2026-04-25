-- tests/registry_spec.lua
-- Schema-conformance: every tool in schema/tools.json must have a handler.

describe('blackbox.tools registry', function()
    local registry, schema

    before_each(function()
        package.loaded['blackbox.tools.init'] = nil
        registry = require('blackbox.tools.init')
        local schema_path = vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2), ':p:h:h:h:h') .. '/schema/tools.json'
        local raw = table.concat(vim.fn.readfile(schema_path), '\n')
        schema = vim.json.decode(raw)
    end)

    it('has a handler for every tool in schema/tools.json', function()
        local missing = {}
        for _, tool in ipairs(schema.tools) do
            if not registry.has(tool.name) then table.insert(missing, tool.name) end
        end
        assert.are.same({}, missing)
    end)

    it('does not register tools missing from the schema', function()
        local in_schema = {}
        for _, tool in ipairs(schema.tools) do in_schema[tool.name] = true end
        local extras = {}
        for _, name in ipairs(registry.tool_names()) do
            if not in_schema[name] then table.insert(extras, name) end
        end
        assert.are.same({}, extras)
    end)
end)
