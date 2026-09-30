import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { callExtension } from '../ipc/client';
import { listWindows } from '../ipc/registry';
import { BridgeSession, RoutingError, WindowView, windowLabel } from './session';
import { ancestorPids } from './launch';
import { loadTools, validate } from './toolSchema';

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

async function run(tool: string, args: Record<string, unknown>, timeoutMs = TIMEOUT_MS[tool] ?? DEFAULT_TIMEOUT_MS) {
    try {
        const { route, resp } = await session.call({ tool, args, timeoutMs });
        // Name the window only when there is more than one to confuse.
        const prefix = route.window && route.windows.length > 1 ? `[window: ${windowLabel(route.window, route.windows)}]\n` : '';
        return resp.error ? txt(prefix + 'Error: ' + resp.error, true) : txt(prefix + (resp.result || ''));
    } catch (err: unknown) {
        return formatFailure(err);
    }
}

const MAX_WAIT_MS = 300_000;

// Tools answered here rather than by the editor window.
const LOCAL_TOOLS: Record<string, (args: Record<string, any>) => Promise<ReturnType<typeof txt>>> = {
    ide_list_windows: async () => txt(JSON.stringify(await session.describe(), null, 2)),
    ide_select_window: async ({ window, app }) => {
        const selected = session.select(window, app);
        return txt(selected
            ? `Selected ${selected.app.name} · ${windowLabel(selected)} (window ${selected.id}): ${selected.folders.join(', ')}`
            : 'Selection cleared; windows are chosen automatically again.');
    },
};

// Tools that wait inside the editor: cap their wait, and give the bridge
// call a little longer than that.
const WAITING_TOOLS: Record<string, { defaultMs: number; marginMs: number }> = {
    debug_wait_for_stop: { defaultMs: 30_000, marginMs: 5_000 },
    debug_run_to_line: { defaultMs: 30_000, marginMs: 10_000 },
};

async function callTool(name: string, args: Record<string, any>) {
    const local = LOCAL_TOOLS[name];
    if (local) {
        return local(args).catch(formatFailure);
    }
    const waiting = WAITING_TOOLS[name];
    if (waiting) {
        const timeoutMs = Math.min(args.timeoutMs ?? waiting.defaultMs, MAX_WAIT_MS);
        return run(name, { ...args, timeoutMs }, timeoutMs + waiting.marginMs);
    }
    return run(name, args);
}

const tools = loadTools();
const byName = new Map(tools.map(t => [t.name, t]));

const server = new Server({ name: 'blackbox', version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({ name: t.name, title: t.displayName, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
}));

server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args = {} } = request.params;
    const tool = byName.get(name);
    if (!tool) {
        return txt(`Unknown tool "${name}".`, true);
    }
    const problems = validate(tool.inputSchema, args);
    if (problems.length > 0) {
        return txt(`Invalid arguments for ${name}: ${problems.join('; ')}.`, true);
    }
    return callTool(name, args);
});

async function main() {
    await server.connect(new StdioServerTransport());
}

main().catch(err => { console.error('blackbox MCP error:', err); process.exit(1); });
