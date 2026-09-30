// Keeps the three tool lists in step: the MCP server, schema/tools.json and
// the VS Code chat tools in package.json.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const EXTENSION_ROOT = path.resolve(__dirname, '../../..');
const REPO_ROOT = path.resolve(EXTENSION_ROOT, '../..');

function readJson(file: string): any {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

suite('Tool contract', () => {
    let mcpTools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[];

    suiteSetup(async function () {
        this.timeout(15000);
        const client = new Client({ name: 'contract', version: '0.0.0' });
        await client.connect(new StdioClientTransport({
            command: process.execPath,
            args: [path.join(EXTENSION_ROOT, 'out/mcp/server.js')],
        }));
        try {
            mcpTools = (await client.listTools()).tools as typeof mcpTools;
        } finally {
            await client.close();
        }
    });

    test('the MCP server exposes exactly the tools in schema/tools.json', () => {
        const schema = readJson(path.join(REPO_ROOT, 'schema/tools.json')).tools.map((t: { name: string }) => t.name).sort();
        assert.deepStrictEqual(mcpTools.map(t => t.name).sort(), schema);
    });

    test('every schema parameter exists on the MCP tool', () => {
        const byName = new Map(mcpTools.map(t => [t.name, Object.keys(t.inputSchema.properties ?? {})]));
        for (const tool of readJson(path.join(REPO_ROOT, 'schema/tools.json')).tools) {
            for (const param of Object.keys(tool.inputSchema?.properties ?? {})) {
                assert.ok(byName.get(tool.name)?.includes(param), `${tool.name} is missing "${param}"`);
            }
        }
    });

    test('VS Code chat tools are a subset of the MCP tools', () => {
        const chat: string[] = readJson(path.join(EXTENSION_ROOT, 'package.json')).contributes.languageModelTools.map((t: { name: string }) => t.name);
        const mcp = new Set(mcpTools.map(t => t.name));
        assert.deepStrictEqual(chat.filter(name => !mcp.has(name)), []);
    });
});
