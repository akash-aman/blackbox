-- lua/blackbox/util/json.lua
-- Helpers around vim.json so handlers always emit a string (never nil/empty).

local M = {}

function M.encode(value)
    if value == nil then return '' end
    local ok, encoded = pcall(vim.json.encode, value)
    if not ok then return tostring(value) end
    return encoded
end

function M.encode_pretty(value)
    -- vim.json has no built-in pretty option; use a tiny indenter.
    local raw = M.encode(value)
    local depth = 0
    local out = {}
    local i = 1
    local in_string = false
    while i <= #raw do
        local c = raw:sub(i, i)
        if c == '"' and raw:sub(i - 1, i - 1) ~= '\\' then in_string = not in_string end
        if not in_string then
            if c == '{' or c == '[' then
                depth = depth + 1
                table.insert(out, c .. '\n' .. string.rep('  ', depth))
            elseif c == '}' or c == ']' then
                depth = depth - 1
                table.insert(out, '\n' .. string.rep('  ', depth) .. c)
            elseif c == ',' then
                table.insert(out, ',\n' .. string.rep('  ', depth))
            elseif c == ':' then
                table.insert(out, ': ')
            else
                table.insert(out, c)
            end
        else
            table.insert(out, c)
        end
        i = i + 1
    end
    return table.concat(out)
end

return M
