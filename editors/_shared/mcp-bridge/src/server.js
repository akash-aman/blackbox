#!/usr/bin/env node
/*
 * @blackbox/mcp-bridge — shared stdio MCP server.
 *
 * Reads every tool from ../../../schema/tools.json and forwards calls over a
 * Unix-domain socket using the wire format defined in
 * ../../vscode/src/ipc/protocol.ts.
 *
 *   stdin/stdout (MCP) ──► this process ──► UDS (NDJSON) ──► editor host
 *
 * Configuration:
 *   BLACKBOX_SOCKET  Required. Absolute path to the editor's IPC socket.
 *   BLACKBOX_TIMEOUT Optional. Per-call timeout in milliseconds (default 15000).
 */

'use strict';

const net = require('net');
const path = require('path');
const fs = require('fs');

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

// ── Config ──────────────────────────────────────────────────────────────────

const SOCKET_PATH = process.env.BLACKBOX_SOCKET;
if (!SOCKET_PATH) {
    console.error('blackbox-mcp: BLACKBOX_SOCKET environment variable is required');
    process.exit(1);
}
const TIMEOUT_MS = Number(process.env.BLACKBOX_TIMEOUT || 15_000);

// ── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA_PATH = path.resolve(__dirname, '..', '..', '..', '..', 'schema', 'tools.json');
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));

// JSON-Schema → Zod (only the small subset we need from schema/tools.json).
function zFromJson(node) {
    if (!node || typeof node !== 'object') return z.any();
    switch (node.type) {
        case 'string': return z.string();
        case 'number': return z.number();
        case 'integer': return z.number().int();
        case 'boolean': return z.boolean();
        case 'array': return z.array(zFromJson(node.items || {}));
        case 'object': {
            const shape = {};
            const required = new Set(node.required || []);
            for (const [key, prop] of Object.entries(node.properties || {})) {
                let s = zFromJson(prop);
                if (!required.has(key)) s = s.optional();
                if (prop && prop.description) s = s.describe(prop.description);
                shape[key] = s;
            }
            return z.object(shape);
        }
        default: return z.any();
    }
}

// McpServer.registerTool expects inputSchema as a plain shape (key → Zod field),
// not a wrapped z.object. Unwrap when the schema is an object.
function toShape(schema) {
    if (!schema) return undefined;
    if (schema instanceof z.ZodObject) return schema.shape;
    return undefined;
}

// ── IPC client ──────────────────────────────────────────────────────────────

let nextId = 0;
function callExtension(tool, args) {
    return new Promise((resolve, reject) => {
        const id = String(++nextId);
        const req = JSON.stringify({ id, tool, args }) + '\n';
        const client = net.createConnection(SOCKET_PATH, () => client.write(req));
        let buffer = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            client.destroy();
            reject(new Error(`IPC timeout after ${TIMEOUT_MS}ms`));
        }, TIMEOUT_MS);

        client.on('data', chunk => {
            buffer += chunk.toString();
            const nl = buffer.indexOf('\n');
            if (nl < 0 || settled) return;
            settled = true;
            clearTimeout(timer);
            try {
                const resp = JSON.parse(buffer.slice(0, nl));
                resolve(resp.error ? `Error: ${resp.error}` : (resp.result || ''));
            } catch (err) {
                resolve(buffer);
            }
            client.end();
        });

        client.on('error', err => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(
                `IPC connection failed at ${SOCKET_PATH} — is the Blackbox editor extension active? (${err.message})`,
            ));
        });
    });
}

// ── Register tools from schema ──────────────────────────────────────────────

const server = new McpServer({ name: 'blackbox', version: '0.1.0' });

for (const tool of schema.tools) {
    const inputZod = tool.inputSchema ? zFromJson(tool.inputSchema) : undefined;
    const config = { description: tool.description };
    const shape = toShape(inputZod);
    if (shape) config.inputSchema = shape;
    server.registerTool(tool.name, config, async (args = {}) => {
        const text = await callExtension(tool.name, args);
        return { content: [{ type: 'text', text }] };
    });
}

// ── Start ───────────────────────────────────────────────────────────────────

(async () => {
    const transport = new StdioServerTransport();
    await server.connect(transport);
})().catch(err => {
    console.error('blackbox-mcp error:', err);
    process.exit(1);
});
