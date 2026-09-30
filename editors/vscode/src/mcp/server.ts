import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { callExtension } from '../ipc/client';
import { listWindows } from '../ipc/registry';
import { BridgeSession, RoutingError, WindowView, windowLabel } from './session';
import { ancestorPids } from './launch';

// Resolved from out/mcp/ at runtime; outside tsc's rootDir, so not imported.
const { version } = require('../../package.json') as { version: string };

const DEFAULT_TIMEOUT_MS = 15_000;

// Tools that can legitimately take longer than the default.
const TIMEOUT_MS: Record<string, number> = {
    debug_start: 60_000,
    debug_restart: 60_000,
    debug_evaluate: 30_000,
    debug_get_variables: 30_000,
    debug_inspect: 30_000,
    debug_watch: 30_000,
    debug_step_over: 30_000,
    debug_step_into: 30_000,
    debug_step_out: 30_000,
    workspace_find_file: 30_000,
};

const INSTRUCTIONS = `Blackbox controls debuggers in running editor windows (VS Code, Cursor, and other VS Code-based editors). Several windows may be open at once.
Calls go to the window whose folder contains this server's working directory; ties are broken by the window or editor this session was started from.
If a call fails because the window is ambiguous or missing, or you are unsure which window you are using, call ide_list_windows, then ide_select_window with the window you want.
Typical loop: debug_get_launch_configs, debug_start {configName}, debug_set_breakpoint, trigger the code, debug_wait_for_stop, then step/inspect; read logpoints and program output with debug_get_output.`;

const session = new BridgeSession({
    listWindows,
    send: callExtension,
    cwd: process.cwd(),
    env: process.env,
    ancestors: ancestorPids(),
});

function txt(text: string, isError = false) { return { content: [{ type: 'text' as const, text }], isError }; }

function formatCandidate(view: WindowView, label: string): string {
    const debug = view.debug ? ` · ${view.debug.type} session ${view.debug.state}` : '';
    const launched = view.launchedFrom ? ` · this session was started from its ${view.launchedFrom === 'window' ? 'window' : 'editor'}` : '';
    const outdated = view.outdated ? ' · older extension' : '';
    return `- ${view.app.name} · ${label} (window ${view.window})${debug}${launched}${outdated}: ${view.folders.join(', ') || '(no folder)'}`;
}

async function formatRoutingError(err: RoutingError) {
    const hint = err.code === 'NO_WINDOWS'
        ? 'Open the project in VS Code (or another VS Code-based editor) with the Blackbox extension enabled.'
        : 'Call ide_select_window with one of these windows (add "app" to pick an editor).';
    const views = await session.describe(err.candidates);
    const list = views.length === 0
        ? 'No windows are running.'
        : 'Windows:\n' + views.map((v, i) => formatCandidate(v, windowLabel(err.candidates[i]))).join('\n');
    return txt(`${err.message}\n\n${list}\n\n${hint}`, true);
}

async function formatFailure(err: unknown) {
    if (err instanceof RoutingError) {
        return formatRoutingError(err);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return txt(`Could not reach VS Code: ${msg}`, true);
}

async function run(tool: string, args: Record<string, unknown> = {}, timeoutMs = TIMEOUT_MS[tool] ?? DEFAULT_TIMEOUT_MS) {
    try {
        const { route, resp } = await session.call({ tool, args, timeoutMs });
        // Name the window only when there is more than one to confuse.
        const prefix = route.window && route.windows.length > 1 ? `[window: ${windowLabel(route.window, route.windows)}]\n` : '';
        return resp.error ? txt(prefix + 'Error: ' + resp.error, true) : txt(prefix + (resp.result || ''));
    } catch (err: unknown) {
        return formatFailure(err);
    }
}

const server = new McpServer({ name: 'blackbox', version }, { instructions: INSTRUCTIONS });

// ── Windows ─────────────────────────────────────────────────────

server.registerTool('ide_list_windows', {
    description: 'List the editor windows Blackbox can control (VS Code, Cursor, ...): their editor, folders, which one this session uses, whether this session was started from it, and each debugger\'s state (running, or stopped at file:line). Use it to choose a window before debugging when several are open.',
}, async () => txt(JSON.stringify(await session.describe(), null, 2)));

server.registerTool('ide_select_window', {
    description: 'Choose the editor window this session controls, by window id, folder path or folder name from ide_list_windows. Pass app (e.g. "Cursor") when the same folder is open in several editors. Omit window to go back to automatic selection.',
    inputSchema: {
        window: z.string().optional().describe('Window id, absolute folder path, or folder name (e.g. "wpcore.wpx")'),
        app: z.string().optional().describe('Editor name, or part of it, e.g. "Cursor", "Visual Studio Code", "Antigravity"'),
    },
}, async ({ window, app }) => {
    try {
        const selected = session.select(window, app);
        return txt(selected
            ? `Selected ${selected.app.name} · ${windowLabel(selected)} (window ${selected.id}): ${selected.folders.join(', ')}`
            : 'Selection cleared; windows are chosen automatically again.');
    } catch (err: unknown) {
        return formatFailure(err);
    }
});

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
    description: 'Start a debug session through the Debug Adapter Protocol (DAP) for the detected language stack (Node.js, Python, PHP, Go, ...). Prefer configName: call debug_get_launch_configs first and pass the name of an existing launch configuration, so its ports, path mappings and adapter settings are used as-is. Otherwise pass type and request (and port, program, pathMappings). Note for web environments: if the stack uses request-triggered debugging (like Xdebug for PHP), trigger it on HTTP requests (e.g. ?XDEBUG_TRIGGER=1 or a session cookie).',
    inputSchema: {
        configName: z.string().optional().describe('Name of a launch configuration (or compound) from debug_get_launch_configs'),
        folder: z.string().optional().describe('Workspace folder path whose launch configuration to use, when several have the same name'),
        type: z.string().optional().describe('Debug adapter type when not using configName: php, node, python, go, cppdbg, java, etc'),
        request: z.string().optional().describe('launch or attach, when not using configName'),
        name: z.string().optional(), port: z.number().optional(), program: z.string().optional(), pathMappings: z.record(z.string(), z.string()).optional(),
    },
}, async (args) => run('debug_start', args));

server.registerTool('debug_stop', {
    description: 'Stop the currently active debug session.',
}, async () => run('debug_stop'));

server.registerTool('debug_restart', {
    description: 'Restart the currently active debug session.',
}, async () => run('debug_restart'));

// ── Execution Control (play/pause/step) ─────────────────────────

server.registerTool('debug_continue', {
    description: 'Resume execution (play button). Does not wait: call debug_wait_for_stop to wait for the next pause.',
    inputSchema: { threadId: z.number().optional().describe('Thread to act on (default: the paused or focused thread)') },
}, async (args) => run('debug_continue', args));

server.registerTool('debug_pause', {
    description: 'Pause a running program (pause button) and report where it stopped.',
    inputSchema: { threadId: z.number().optional().describe('Thread to act on (default: the paused or focused thread)') },
}, async (args) => run('debug_pause', args));

server.registerTool('debug_step_over', {
    description: 'Execute the next line, stepping over function calls, and report the new location (file, line, function, top frames).',
    inputSchema: { threadId: z.number().optional().describe('Thread to act on (default: the paused or focused thread)') },
}, async (args) => run('debug_step_over', args));

server.registerTool('debug_step_into', {
    description: 'Step into the next function call and report the new location.',
    inputSchema: { threadId: z.number().optional().describe('Thread to act on (default: the paused or focused thread)') },
}, async (args) => run('debug_step_into', args));

server.registerTool('debug_step_out', {
    description: 'Step out of the current function and report the new location.',
    inputSchema: { threadId: z.number().optional().describe('Thread to act on (default: the paused or focused thread)') },
}, async (args) => run('debug_step_out', args));

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

server.registerTool('debug_wait_for_stop', {
    description: 'Wait until the debugger pauses (breakpoint, exception, step, pause) and report where: reason, file, line, function and the top frames. Returns at once if it is already paused. Use after debug_start or debug_continue, or after triggering the code (e.g. an HTTP request with ?XDEBUG_TRIGGER=1). Returns {state:"running"} on timeout, which is not an error: call it again to keep waiting.',
    inputSchema: { timeoutMs: z.number().optional().describe('How long to wait (default 30000, max 300000)') },
}, async (args) => {
    const timeoutMs = Math.min(args.timeoutMs ?? 30_000, 300_000);
    return run('debug_wait_for_stop', { timeoutMs }, timeoutMs + 5_000);
});

server.registerTool('debug_get_output', {
    description: 'Read program output and debug console messages, including logpoint messages from debug_set_breakpoint logMessage. Pass since = nextSince from the previous call to get only new entries; more: true means entries were left out. Long entries are shortened. Use match to filter, since some adapters log their own protocol traffic here.',
    inputSchema: {
        since: z.number().optional().describe('Return entries after this sequence number (default 0: everything kept)'),
        category: z.string().optional().describe('Only this category: stdout, stderr, console, important'),
        match: z.string().optional().describe('Only entries containing this text (case-insensitive), e.g. "logpoint"'),
        limit: z.number().optional().describe('Maximum entries (default 200)'),
    },
}, async (args) => run('debug_get_output', args));

server.registerTool('debug_set_exception_breakpoints', {
    description: 'Pause when exceptions are thrown. Call without filters to list the filters the active debug adapter offers (e.g. PHP: Notice, Warning, Exception; Node: all, uncaught), then call with the ones to enable. Pass an empty list to turn them off. Applies to the active session only and is not shown in VS Code\'s Breakpoints panel.',
    inputSchema: { filters: z.array(z.string()).optional().describe('Filter ids from the list call') },
}, async (args) => run('debug_set_exception_breakpoints', args));

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