import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { callExtension } from '../ipc/client';
import { listWindows } from '../ipc/registry';

const DEFAULT_TIMEOUT_MS = 15_000;

// Tools that can legitimately take longer than the default.
const TIMEOUT_MS: Record<string, number> = {
    debug_start: 60_000,
    debug_restart: 60_000,
    debug_evaluate: 30_000,
    debug_get_variables: 30_000,
    debug_inspect: 30_000,
    debug_watch: 30_000,
    workspace_find_file: 30_000,
};

function txt(text: string, isError = false) { return { content: [{ type: 'text' as const, text }], isError }; }

function describeWindows(): string {
    const windows = listWindows();
    if (windows.length === 0) {
        return 'No VS Code window with the Blackbox extension is running.';
    }
    return 'Running windows:\n' + windows.map(w => `- pid ${w.pid}: ${w.folders.join(', ') || '(no folder)'}`).join('\n');
}

async function run(tool: string, args: Record<string, unknown> = {}) {
    try {
        const resp = await callExtension(tool, args, { timeoutMs: TIMEOUT_MS[tool] ?? DEFAULT_TIMEOUT_MS });
        return resp.error ? txt('Error: ' + resp.error, true) : txt(resp.result || '');
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return txt(`Could not reach VS Code: ${msg}\n\nMCP server cwd: ${process.cwd()}\n${describeWindows()}`, true);
    }
}

const server = new McpServer({ name: 'blackbox', version: '0.1.0' });

const bpSchema = z.object({ file: z.string(), line: z.number(), condition: z.string().optional(), logMessage: z.string().optional() });

// ── Breakpoints ─────────────────────────────────────────────────

server.registerTool('debug_set_breakpoint', {
    description: 'Set breakpoints in source files to pause execution. Analyze the workspace context to determine the appropriate files to target (e.g., core entry points, routing modules, controllers, or framework-specific extensions). Adapts to any language (PHP, JavaScript, Python, Go, etc.). Pass a single file+line or an array of breakpoints.',
    inputSchema: { file: z.string().optional(), line: z.number().optional(), condition: z.string().optional(), logMessage: z.string().optional(), breakpoints: z.array(bpSchema).optional() },
}, async (args) => run('debug_set_breakpoint', args));

server.registerTool('debug_remove_breakpoint', {
    description: 'Remove one or more breakpoints by file+line.',
    inputSchema: { file: z.string().optional(), line: z.number().optional(), breakpoints: z.array(z.object({ file: z.string(), line: z.number() })).optional() },
}, async (args) => run('debug_remove_breakpoint', args));

server.registerTool('debug_remove_all_breakpoints', {
    description: 'Remove all breakpoints at once.',
}, async () => run('debug_remove_all_breakpoints'));

server.registerTool('debug_list_breakpoints', {
    description: 'List all currently set breakpoints with file, line, condition, and enabled status.',
}, async () => run('debug_list_breakpoints'));

// ── Session Control ─────────────────────────────────────────────

server.registerTool('debug_start', {
    description: 'Start a debug session utilizing the Debug Adapter Protocol (DAP) for the detected language stack (e.g., Node.js, Python, PHP, Go). Use debug_get_launch_configs FIRST to find existing launch.json configurations to inherit correct ports and mappings. Note for web environments: If the detected stack relies on request-triggered debugging (like Xdebug for PHP), ensure appropriate triggers (e.g., URL parameters like ?XDEBUG_TRIGGER=1 or specific session cookies) are utilized during HTTP requests. Adapt networking logic to the project environment.',
    inputSchema: { type: z.string().describe('Debug adapter type inferred from workspace: php, node, python, go, cppdbg, java, etc'), request: z.string().describe('launch or attach'), name: z.string().optional(), port: z.number().optional(), program: z.string().optional(), pathMappings: z.record(z.string(), z.string()).optional() },
}, async (args) => run('debug_start', args));

server.registerTool('debug_stop', {
    description: 'Stop the currently active debug session.',
}, async () => run('debug_stop'));

server.registerTool('debug_restart', {
    description: 'Restart the currently active debug session.',
}, async () => run('debug_restart'));

// ── Execution Control (play/pause/step) ─────────────────────────

server.registerTool('debug_continue', {
    description: 'Resume execution after hitting a breakpoint (play button).',
}, async () => run('debug_continue'));

server.registerTool('debug_pause', {
    description: 'Pause a running program (pause button).',
}, async () => run('debug_pause'));

server.registerTool('debug_step_over', {
    description: 'Execute the next line, stepping over function calls (step over button).',
}, async () => run('debug_step_over'));

server.registerTool('debug_step_into', {
    description: 'Step into the next function call (step into button).',
}, async () => run('debug_step_into'));

server.registerTool('debug_step_out', {
    description: 'Step out of the current function (step out button).',
}, async () => run('debug_step_out'));

// ── Inspection ──────────────────────────────────────────────────

server.registerTool('debug_evaluate', {
    description: 'Evaluate an expression at the current breakpoint. You must strictly use the exact syntax of the language currently being debugged (e.g., "$var" for PHP, "object.property" for JS, "self.attr" for Python). Tailor the expression to the active framework detected in the workspace.',
    inputSchema: { expression: z.string(), frameId: z.number().optional() },
}, async (args) => run('debug_evaluate', args));

server.registerTool('debug_get_variables', {
    description: 'Get all variables in the current scope when stopped at a breakpoint. Automatically analyzes locals, globals, and environment objects. Use context awareness to look for framework-specific global states, request/response payloads, or database objects depending on the active language runtime. Can filter by name.',
    inputSchema: { variablesReference: z.number().optional(), filter: z.string().optional() },
}, async (args) => run('debug_get_variables', args));

server.registerTool('debug_get_stack_trace', {
    description: 'Get the call stack when stopped at a breakpoint. Shows file, line, function for each frame.',
}, async () => run('debug_get_stack_trace'));

server.registerTool('debug_get_launch_configs', {
    description: 'List all debug launch configurations from workspace launch.json files. Use this FIRST before debug_start to find existing configurations with the correct port, path mappings, and environment-specific settings.',
}, async () => run('debug_get_launch_configs'));

server.registerTool('debug_inspect', {
    description: 'Deep inspect a variable at the current breakpoint. Recursively expands nested data structures (arrays, objects, structs, maps). Supply the variable name using the correct language syntax. Ideal for examining complex framework-specific objects, global application states, or config objects derived from the active project context.',
    inputSchema: {
        variable: z.string().describe('Variable or expression to inspect formatted for the active language runtime (e.g., "$global_state", "req.body", "self.config")'),
        depth: z.number().optional().describe('Max expansion depth (1-5, default: 2)'),
        maxItems: z.number().optional().describe('Max items per array/object level (default: 50, max: 200)'),
    },
}, async (args) => run('debug_inspect', args));

server.registerTool('debug_watch', {
    description: 'Manage watch expressions. Add expressions to watch, remove them, or evaluate all watches at once. Watches persist across step/continue operations — call with action="list" after each step to see how values changed.',
    inputSchema: {
        action: z.enum(['add', 'remove', 'list', 'clear']).describe('add: add expressions, remove: remove expressions, list: evaluate all watches, clear: remove all watches'),
        expressions: z.array(z.string()).optional().describe('Expressions to add/remove matching the active language syntax'),
    },
}, async (args) => run('debug_watch', args));

// ── Editor ──────────────────────────────────────────────────────

server.registerTool('editor_open_file', {
    description: 'Open a file in VS Code at a specific line.',
    inputSchema: { file: z.string(), line: z.number().optional() },
}, async (args) => run('editor_open_file', args));

server.registerTool('editor_get_open_files', {
    description: 'List all files open in editor tabs.',
}, async () => run('editor_get_open_files'));

// ── Workspace ───────────────────────────────────────────────────

server.registerTool('workspace_find_file', {
    description: 'Find files by glob pattern in the workspace. Use to locate source files, application entry points, or framework-specific modules before setting breakpoints or reviewing code.',
    inputSchema: { pattern: z.string(), maxResults: z.number().optional() },
}, async (args) => run('workspace_find_file', args));

server.registerTool('workspace_get_diagnostics', {
    description: 'Get errors and warnings from all language services.',
    inputSchema: { file: z.string().optional(), severity: z.string().optional() },
}, async (args) => run('workspace_get_diagnostics', args));

// ── Start ───────────────────────────────────────────────────────

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch(err => { console.error('blackbox MCP error:', err); process.exit(1); });