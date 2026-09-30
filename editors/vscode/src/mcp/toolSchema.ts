// The tool contract (schema/tools.json, copied to out/tools.json at build)
// and argument checking against it. The MCP server lists these definitions
// as-is, so MCP clients and VS Code chat see the same names, descriptions,
// parameters and annotations.

import * as fs from 'fs';
import * as path from 'path';

export interface JsonSchema {
    type?: 'object' | 'array' | 'string' | 'number' | 'boolean';
    description?: string;
    properties?: Record<string, JsonSchema>;
    required?: string[];
    items?: JsonSchema;
    enum?: unknown[];
    additionalProperties?: boolean | JsonSchema;
}

export interface ToolDefinition {
    name: string;
    displayName: string;
    description: string;
    inputSchema: JsonSchema;
    annotations: Record<string, unknown>;
}

export function loadTools(file = path.resolve(__dirname, '../tools.json')): ToolDefinition[] {
    return JSON.parse(fs.readFileSync(file, 'utf8')).tools;
}

function typeOf(value: unknown): string {
    if (Array.isArray(value)) { return 'array'; }
    if (value === null) { return 'null'; }
    return typeof value;
}

// Returns problems with `value` against `schema`, as "<path> must be ..."
// messages; empty when it is valid. Checks types, required properties and
// enums, which is all the tool contract uses.
export function validate(schema: JsonSchema, value: unknown, at = 'arguments'): string[] {
    if (schema.type === 'number' ? typeof value !== 'number' || !Number.isFinite(value)
        : schema.type === 'object' ? typeOf(value) !== 'object'
            : schema.type !== undefined && typeOf(value) !== schema.type) {
        return [`${at} must be ${schema.type === 'array' || schema.type === 'object' ? 'an' : 'a'} ${schema.type}`];
    }
    if (schema.enum && !schema.enum.includes(value)) {
        return [`${at} must be one of ${schema.enum.map(v => JSON.stringify(v)).join(', ')}`];
    }
    if (schema.type === 'array') {
        return (value as unknown[]).flatMap((item, i) => schema.items ? validate(schema.items, item, `${at}[${i}]`) : []);
    }
    if (schema.type !== 'object') {
        return [];
    }

    const record = value as Record<string, unknown>;
    const missing = (schema.required ?? []).filter(key => record[key] === undefined).map(key => `${at}.${key} is required`);
    const invalid = Object.entries(record).flatMap(([key, child]) => {
        const childSchema = schema.properties?.[key]
            ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined);
        return childSchema && child !== undefined ? validate(childSchema, child, `${at}.${key}`) : [];
    });
    return [...missing, ...invalid];
}
