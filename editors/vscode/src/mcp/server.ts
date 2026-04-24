import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as net from 'net';
import { IPC_SOCKET_PATH, IPCRequest, IPCResponse } from '../ipc/protocol';

let requestId = 0;

function callExtension(tool: string, args: Record<string, unknown>): Promise<string> {
    return new Promise((resolve, reject) => {
        const id = String(++requestId);
        const req: IPCRequest = { id, tool, args };
        const client = net.createConnection(IPC_SOCKET_PATH, () => {
            client.write(JSON.stringify(req) + '\n');
        });
        let buffer = '';
        client.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const nl = buffer.indexOf('\n');
            if (nl >= 0) {
                try {
                    const resp: IPCResponse = JSON.parse(buffer.slice(0, nl));
                    resolve(resp.error ? 'Error: ' + resp.error : resp.result || '');
                } catch { resolve(buffer); }
                client.end();
            }
        });
        client.on('error', (err: Error) => {
            reject(new Error('IPC connection failed — is the blackbox extension active? (' + err.message + ')'));
        });
        client.setTimeout(10000, () => { client.destroy(); reject(new Error('IPC timeout')); });
    });
}

function txt(text: string) { return { content: [{ type: 'text' as const, text }] }; }

const server = new McpServer({ name: 'blackbox', version: '0.1.0' });

const bpSchema = z.object({ file: z.string(), line: z.number(), condition: z.string().optional(), logMessage: z.string().optional() });

// ── Breakpoints ─────────────────────────────────────────────────

server.registerTool('debug_set_breakpoint', {
    description: 'Set breakpoints in source files to pause execution. Analyze the workspace context to determine the appropriate files to target (e.g., core entry points, routing modules, controllers, or framework-specific extensions). Adapts to any language (PHP, JavaScript, Python, Go, etc.). Pass a single file+line or an array of breakpoints.',
    inputSchema: { file: z.string().optional(), line: z.number().optional(), condition: z.string().optional(), logMessage: z.string().optional(), breakpoints: z.array(bpSchema).optional() },
}, async (args) => txt(await callExtension('debug_set_breakpoint', args)));

server.registerTool('debug_remove_breakpoint', {
    description: 'Remove one or more breakpoints by file+line.',
    inputSchema: { file: z.string().optional(), line: z.number().optional(), breakpoints: z.array(z.object({ file: z.string(), line: z.number() })).optional() },
}, async (args) => txt(await callExtension('debug_remove_breakpoint', args)));

server.registerTool('debug_remove_all_breakpoints', {
    description: 'Remove all breakpoints at once.',
}, async () => txt(await callExtension('debug_remove_all_breakpoints', {})));

server.registerTool('debug_list_breakpoints', {
    description: 'List all currently set breakpoints with file, line, condition, and enabled status.',
}, async () => txt(await callExtension('debug_list_breakpoints', {})));

// ── Session Control ─────────────────────────────────────────────

server.registerTool('debug_start', {
    description: 'Start a debug session utilizing the Debug Adapter Protocol (DAP) for the detected language stack (e.g., Node.js, Python, PHP, Go). Use debug_get_launch_configs FIRST to find existing launch.json configurations to inherit correct ports and mappings. Note for web environments: If the detected stack relies on request-triggered debugging (like Xdebug for PHP), ensure appropriate triggers (e.g., URL parameters like ?XDEBUG_TRIGGER=1 or specific session cookies) are utilized during HTTP requests. Adapt networking logic to the project environment.',
    inputSchema: { type: z.string().describe('Debug adapter type inferred from workspace: php, node, python, go, cppdbg, java, etc'), request: z.string().describe('launch or attach'), name: z.string().optional(), port: z.number().optional(), program: z.string().optional(), pathMappings: z.record(z.string(), z.string()).optional() },
}, async (args) => txt(await callExtension('debug_start', args)));

server.registerTool('debug_stop', {
    description: 'Stop the currently active debug session.',
}, async () => txt(await callExtension('debug_stop', {})));

server.registerTool('debug_restart', {
    description: 'Restart the currently active debug session.',
}, async () => txt(await callExtension('debug_restart', {})));

// ── Execution Control (play/pause/step) ─────────────────────────

server.registerTool('debug_continue', {
    description: 'Resume execution after hitting a breakpoint (play button).',
}, async () => txt(await callExtension('debug_continue', {})));

server.registerTool('debug_pause', {
    description: 'Pause a running program (pause button).',
}, async () => txt(await callExtension('debug_pause', {})));

server.registerTool('debug_step_over', {
    description: 'Execute the next line, stepping over function calls (step over button).',
}, async () => txt(await callExtension('debug_step_over', {})));

server.registerTool('debug_step_into', {
    description: 'Step into the next function call (step into button).',
}, async () => txt(await callExtension('debug_step_into', {})));

server.registerTool('debug_step_out', {
    description: 'Step out of the current function (step out button).',
}, async () => txt(await callExtension('debug_step_out', {})));

// ── Inspection ──────────────────────────────────────────────────

server.registerTool('debug_evaluate', {
    description: 'Evaluate an expression at the current breakpoint. You must strictly use the exact syntax of the language currently being debugged (e.g., "$var" for PHP, "object.property" for JS, "self.attr" for Python). Tailor the expression to the active framework detected in the workspace.',
    inputSchema: { expression: z.string(), frameId: z.number().optional() },
}, async (args) => txt(await callExtension('debug_evaluate', args)));

server.registerTool('debug_get_variables', {
    description: 'Get all variables in the current scope when stopped at a breakpoint. Automatically analyzes locals, globals, and environment objects. Use context awareness to look for framework-specific global states, request/response payloads, or database objects depending on the active language runtime. Can filter by name.',
    inputSchema: { variablesReference: z.number().optional(), filter: z.string().optional() },
}, async (args) => txt(await callExtension('debug_get_variables', args)));

server.registerTool('debug_get_stack_trace', {
    description: 'Get the call stack when stopped at a breakpoint. Shows file, line, function for each frame.',
}, async () => txt(await callExtension('debug_get_stack_trace', {})));

server.registerTool('debug_get_launch_configs', {
    description: 'List all debug launch configurations from workspace launch.json files. Use this FIRST before debug_start to find existing configurations with the correct port, path mappings, and environment-specific settings.',
}, async () => txt(await callExtension('debug_get_launch_configs', {})));

server.registerTool('debug_inspect', {
    description: 'Deep inspect a variable at the current breakpoint. Recursively expands nested data structures (arrays, objects, structs, maps). Supply the variable name using the correct language syntax. Ideal for examining complex framework-specific objects, global application states, or config objects derived from the active project context.',
    inputSchema: {
        variable: z.string().describe('Variable or expression to inspect formatted for the active language runtime (e.g., "$global_state", "req.body", "self.config")'),
        depth: z.number().optional().describe('Max expansion depth (1-5, default: 2)'),
        maxItems: z.number().optional().describe('Max items per array/object level (default: 50, max: 200)'),
    },
}, async (args) => txt(await callExtension('debug_inspect', args)));

server.registerTool('debug_watch', {
    description: 'Manage watch expressions. Add expressions to watch, remove them, or evaluate all watches at once. Watches persist across step/continue operations — call with action="list" after each step to see how values changed.',
    inputSchema: {
        action: z.enum(['add', 'remove', 'list', 'clear']).describe('add: add expressions, remove: remove expressions, list: evaluate all watches, clear: remove all watches'),
        expressions: z.array(z.string()).optional().describe('Expressions to add/remove matching the active language syntax'),
    },
}, async (args) => txt(await callExtension('debug_watch', args)));

// ── Editor ──────────────────────────────────────────────────────

server.registerTool('editor_open_file', {
    description: 'Open a file in VS Code at a specific line.',
    inputSchema: { file: z.string(), line: z.number().optional() },
}, async (args) => txt(await callExtension('editor_open_file', args)));

server.registerTool('editor_get_open_files', {
    description: 'List all files open in editor tabs.',
}, async () => txt(await callExtension('editor_get_open_files', {})));

// ── Workspace ───────────────────────────────────────────────────

server.registerTool('workspace_find_file', {
    description: 'Find files by glob pattern in the workspace. Use to locate source files, application entry points, or framework-specific modules before setting breakpoints or reviewing code.',
    inputSchema: { pattern: z.string(), maxResults: z.number().optional() },
}, async (args) => txt(await callExtension('workspace_find_file', args)));

server.registerTool('workspace_get_diagnostics', {
    description: 'Get errors and warnings from all language services.',
    inputSchema: { file: z.string().optional(), severity: z.string().optional() },
}, async (args) => txt(await callExtension('workspace_get_diagnostics', args)));

// ── Start ───────────────────────────────────────────────────────

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch(err => { console.error('blackbox MCP error:', err); process.exit(1); });