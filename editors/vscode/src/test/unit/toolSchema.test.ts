// Argument checking against the tool contract.

import * as assert from 'assert';
import { JsonSchema, validate } from '../../mcp/toolSchema';

const BREAKPOINT: JsonSchema = {
    type: 'object',
    properties: {
        file: { type: 'string' },
        line: { type: 'number' },
        breakpoints: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' } }, required: ['file', 'line'] } },
        action: { type: 'string', enum: ['add', 'list'] },
        pathMappings: { type: 'object', additionalProperties: { type: 'string' } },
    },
    required: ['file'],
};

suite('validate', () => {
    test('accepts valid arguments and ignores unknown ones', () => {
        assert.deepStrictEqual(validate(BREAKPOINT, { file: '/a.php', line: 3, extra: true }), []);
    });

    test('reports wrong types, missing required and bad enum values', () => {
        assert.deepStrictEqual(validate(BREAKPOINT, { line: '3', action: 'drop' }), [
            'arguments.file is required',
            'arguments.line must be a number',
            'arguments.action must be one of "add", "list"',
        ]);
    });

    test('checks array items and nested objects', () => {
        assert.deepStrictEqual(validate(BREAKPOINT, { file: '/a', breakpoints: [{ file: '/b', line: 1 }, { line: 2 }, 'x'] }), [
            'arguments.breakpoints[1].file is required',
            'arguments.breakpoints[2] must be an object',
        ]);
    });

    test('checks additionalProperties schemas', () => {
        assert.deepStrictEqual(validate(BREAKPOINT, { file: '/a', pathMappings: { '/srv': '/local', '/tmp': 5 } }), [
            'arguments.pathMappings./tmp must be a string',
        ]);
    });

    test('rejects NaN and null', () => {
        assert.deepStrictEqual(validate(BREAKPOINT, { file: null, line: NaN }), [
            'arguments.file must be a string',
            'arguments.line must be a number',
        ]);
    });
});
