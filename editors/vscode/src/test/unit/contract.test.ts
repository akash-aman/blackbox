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
    let mcpTools: { name: string; title?: string; description?: string; inputSchema: { properties?: Record<string, unknown> }; annotations?: Record<string, unknown> }[];
    const schemaTools = () => readJson(path.join(REPO_ROOT, 'schema/tools.json')).tools;

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

    test('the MCP server serves the schema verbatim: title, description, inputs, annotations', () => {
        const served = new Map(mcpTools.map(t => [t.name, t]));
        for (const tool of schemaTools()) {
            const mcp = served.get(tool.name)!;
            assert.deepStrictEqual(
                { title: mcp.title, description: mcp.description, inputSchema: mcp.inputSchema, annotations: mcp.annotations },
                { title: tool.displayName, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
                tool.name,
            );
        }
    });

    test('the packaged copy of the schema is current', () => {
        assert.deepStrictEqual(readJson(path.join(EXTENSION_ROOT, 'out/tools.json')), readJson(path.join(REPO_ROOT, 'schema/tools.json')));
    });

    test('every tool and parameter, at every level, has a description', () => {
        const undescribed: string[] = [];
        const walk = (schema: any, at: string) => {
            for (const [key, child] of Object.entries<any>(schema.properties ?? {})) {
                if (!child.description?.trim()) { undescribed.push(`${at}.${key}`); }
                if (child.items?.properties) { walk(child.items, `${at}.${key}[]`); }
            }
        };
        for (const tool of schemaTools()) {
            if (tool.description.length < 60) { undescribed.push(`${tool.name} (description too short)`); }
            walk(tool.inputSchema, tool.name);
        }
        assert.deepStrictEqual(undescribed, []);
    });

    test('every tool has a title and read-only / destructive annotations', () => {
        for (const tool of schemaTools()) {
            const a = tool.annotations;
            assert.strictEqual(a.title, tool.displayName, tool.name);
            assert.strictEqual(typeof a.readOnlyHint, 'boolean', tool.name);
            assert.strictEqual(a.openWorldHint, false, tool.name);
            if (!a.readOnlyHint) {
                assert.strictEqual(typeof a.destructiveHint, 'boolean', `${tool.name} needs destructiveHint`);
                assert.strictEqual(typeof a.idempotentHint, 'boolean', `${tool.name} needs idempotentHint`);
            }
        }
    });

    test('tools that run program code or remove things are not marked read-only', () => {
        const byName = new Map(schemaTools().map((t: any) => [t.name, t.annotations]));
        for (const name of ['debug_evaluate', 'debug_inspect', 'debug_watch', 'debug_set_variable', 'debug_remove_all_breakpoints', 'debug_stop']) {
            assert.strictEqual((byName.get(name) as any).readOnlyHint, false, name);
        }
        for (const name of ['debug_remove_all_breakpoints', 'debug_stop', 'debug_set_variable']) {
            assert.strictEqual((byName.get(name) as any).destructiveHint, true, name);
        }
    });

    test('invalid arguments are rejected before reaching the editor', async function () {
        this.timeout(15000);
        const client = new Client({ name: 'contract', version: '0.0.0' });
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(EXTENSION_ROOT, 'out/mcp/server.js')] }));
        try {
            const bad: any = await client.callTool({ name: 'debug_set_breakpoint', arguments: { file: '/x.php', line: 'ten' } });
            assert.strictEqual(bad.isError, true);
            assert.match(bad.content[0].text, /arguments\.line must be a number/);
            const missing: any = await client.callTool({ name: 'debug_evaluate', arguments: {} });
            assert.match(missing.content[0].text, /arguments\.expression is required/);
        } finally {
            await client.close();
        }
    });

    test('VS Code chat offers every tool except the bridge-only ide_* ones', () => {
        const chat: string[] = readJson(path.join(EXTENSION_ROOT, 'package.json')).contributes.languageModelTools.map((t: { name: string }) => t.name);
        const expected = mcpTools.map(t => t.name).filter(name => !name.startsWith('ide_'));
        assert.deepStrictEqual([...chat].sort(), expected.sort(), 'run npm run sync:tools');
    });

    test('package.json chat tools match the schema (npm run sync:tools)', () => {
        const chat = readJson(path.join(EXTENSION_ROOT, 'package.json')).contributes.languageModelTools;
        const schema = readJson(path.join(REPO_ROOT, 'schema/tools.json')).tools.filter((t: { name: string }) => !t.name.startsWith('ide_'));
        assert.deepStrictEqual(
            chat.map((t: any) => ({ name: t.name, description: t.modelDescription, inputSchema: t.inputSchema })),
            schema.map((t: any) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        );
    });
});
