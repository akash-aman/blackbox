// Core debug tool implementations.
// Called by both languageModelTools (tools/debug.ts) and IPC handlers (ipc/handlers.ts).
// All logic uses VS Code Debug Adapter Protocol (DAP) — language-agnostic.

import * as vscode from 'vscode';
import { DebugEvents, OutputQuery, StopEvent, WaitResult } from './debugEvents';

const STEP_WAIT_MS = 10_000;
const PAUSE_WAIT_MS = 5_000;
const DEFAULT_STOP_WAIT_MS = 30_000;
const STOP_FRAMES = 5;
const BREAKPOINT_SYNC_MS = 1_000;

// ── Helpers ─────────────────────────────────────────────────────

let events: DebugEvents<vscode.DebugSession> | undefined;

export function setEventHub(hub: DebugEvents<vscode.DebugSession>) {
    events = hub;
}

function eventHub(): DebugEvents<vscode.DebugSession> {
    if (!events) { throw new Error('debug event tracking is not ready'); }
    return events;
}

// The session commands act on: the focused one if it is paused, otherwise
// the most recently paused one (some adapters, e.g. js-debug, pause a child
// session before the editor focuses it), otherwise the focused one.
function findSession(): vscode.DebugSession | undefined {
    const focused = vscode.debug.activeDebugSession;
    return focused && events?.isPaused(focused.id) ? focused : events?.currentStop()?.session ?? focused;
}

function activeSession(): vscode.DebugSession {
    const session = findSession();
    if (!session) { throw new Error('no active debug session'); }
    return session;
}

// The session the user started; child sessions (e.g. js-debug's) end with it.
function rootSession(session: vscode.DebugSession): vscode.DebugSession {
    return session.parentSession ? rootSession(session.parentSession) : session;
}

// The thread a command should act on: the one asked for, the one focused in
// the editor, the one that last paused, then the first thread.
async function resolveThread(session: vscode.DebugSession, threadId?: number): Promise<number> {
    // Thread ids can be 0 (js-debug), so test for undefined, not falsiness.
    if (threadId !== undefined) { return threadId; }
    const item = vscode.debug.activeStackItem;
    if (item && item.session.id === session.id) { return item.threadId; }
    const stopped = events?.lastStop(session.id)?.threadId;
    if (stopped !== undefined) { return stopped; }
    const threads = await session.customRequest('threads', {});
    const first: number | undefined = threads.threads?.[0]?.id;
    if (first === undefined) { throw new Error('no threads — is the debugger stopped at a breakpoint?'); }
    return first;
}

interface Frame { id: number; name: string; file: string; line: number }

function toFrame(f: { id: number; name: string; line: number; source?: { path?: string; name?: string } }): Frame {
    return { id: f.id, name: f.name, file: f.source?.path || f.source?.name || '(unknown)', line: f.line };
}

async function stackFrames(session: vscode.DebugSession, threadId: number, levels: number): Promise<Frame[]> {
    const stack = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels });
    return (stack.stackFrames || []).map(toFrame);
}

async function topFrameId(session: vscode.DebugSession, threadId: number): Promise<number> {
    const [frame] = await stackFrames(session, threadId, 1);
    if (!frame) { throw new Error('no stack frames — is the debugger stopped at a breakpoint?'); }
    return frame.id;
}

async function describeStop(session: vscode.DebugSession, stop: StopEvent): Promise<Record<string, unknown>> {
    const threadId = stop.threadId ?? await resolveThread(session);
    let frames: Frame[] = [];
    try { frames = await stackFrames(session, threadId, STOP_FRAMES); } catch { /* reported without frames */ }
    const [top] = frames;
    return {
        state: 'stopped', session: session.name, reason: stop.reason, description: stop.description || undefined,
        threadId, file: top?.file, line: top?.line, function: top?.name, frames,
    };
}

async function describeWait(result: WaitResult<vscode.DebugSession>): Promise<string> {
    switch (result.kind) {
        case 'stopped':
            return JSON.stringify(await describeStop(result.session, result.stop), null, 2);
        case 'timeout':
            return JSON.stringify({ state: 'running', hint: 'Not paused yet. Call debug_wait_for_stop to keep waiting.' }, null, 2);
        case 'terminated':
            return JSON.stringify({ state: 'terminated' }, null, 2);
    }
}

// Applies a breakpoint change and waits until a running debug adapter has
// received it, so a continue right after it cannot race the change.
async function changeBreakpoints(apply: () => void): Promise<void> {
    const synced = events?.armResponse('setBreakpoints');
    apply();
    await synced?.(BREAKPOINT_SYNC_MS);
}

// Sends a resuming request and reports where the debugger pauses next.
async function resumeAndReport(command: 'next' | 'stepIn' | 'stepOut' | 'pause', threadId: number | undefined, waitMs: number): Promise<string> {
    const session = activeSession();
    const thread = await resolveThread(session, threadId);
    const wait = eventHub().arm(); // Before the request, so a fast pause is not missed.
    await session.customRequest(command, { threadId: thread });
    return describeWait(await wait(waitMs));
}

export async function expandVar(
    session: vscode.DebugSession,
    ref: number,
    depth: number,
    maxDepth: number,
    maxItems: number
): Promise<unknown> {
    if (depth >= maxDepth || ref <= 0) { return '...'; }
    const vars = await session.customRequest('variables', { variablesReference: ref });
    const items = vars.variables || [];
    const result: Record<string, unknown> = {};
    const limit = Math.min(items.length, maxItems);
    for (let i = 0; i < limit; i++) {
        const v = items[i] as { name: string; value: string; type?: string; variablesReference?: number };
        if (v.variablesReference && v.variablesReference > 0) {
            result[v.name] = await expandVar(session, v.variablesReference, depth + 1, maxDepth, maxItems);
        } else {
            result[v.name] = v.value;
        }
    }
    if (items.length > maxItems) {
        result['...'] = `(${items.length - maxItems} more items)`;
    }
    return result;
}

interface LaunchFile {
    folder: vscode.WorkspaceFolder;
    configurations: { name?: string; [key: string]: unknown }[];
    compounds: { name?: string }[];
}

// Launch configurations as VS Code resolves them (launch.json or the
// workspace file), without hand-parsing JSON with comments.
function readLaunchConfigs(): LaunchFile[] {
    return (vscode.workspace.workspaceFolders || []).map(folder => {
        const launch = vscode.workspace.getConfiguration('launch', folder.uri);
        return {
            folder,
            configurations: launch.get<LaunchFile['configurations']>('configurations', []),
            compounds: launch.get<LaunchFile['compounds']>('compounds', []),
        };
    }).filter(f => f.configurations.length > 0 || f.compounds.length > 0);
}

// Watch expressions — persists across steps within a debug session.
const watchExpressions: Set<string> = new Set();

// ── Tool Implementations ────────────────────────────────────────

export async function setBreakpoint(args: {
    file?: string; line?: number; condition?: string; logMessage?: string;
    breakpoints?: { file: string; line: number; condition?: string; logMessage?: string }[];
}): Promise<string> {
    interface BpSpec { file: string; line: number; condition?: string; logMessage?: string }
    let specs: BpSpec[];
    if (Array.isArray(args.breakpoints)) {
        specs = args.breakpoints;
    } else {
        specs = [{ file: args.file!, line: args.line!, condition: args.condition, logMessage: args.logMessage }];
    }
    const results: string[] = [];
    const bps: vscode.SourceBreakpoint[] = [];
    for (const spec of specs) {
        if (!spec.file || !spec.line || spec.line < 1) {
            results.push('skip: invalid — file and line (>= 1) required');
            continue;
        }
        const uri = vscode.Uri.file(spec.file);
        const pos = new vscode.Position(spec.line - 1, 0);
        bps.push(new vscode.SourceBreakpoint(new vscode.Location(uri, pos), true, spec.condition, undefined, spec.logMessage));
        results.push('ok: ' + spec.file + ':' + spec.line + (spec.condition ? ' (if: ' + spec.condition + ')' : '') + (spec.logMessage ? ' (log: ' + spec.logMessage + ')' : ''));
    }
    if (bps.length > 0) { await changeBreakpoints(() => vscode.debug.addBreakpoints(bps)); }
    return results.join('\n');
}

export async function removeBreakpoint(args: {
    file?: string; line?: number;
    breakpoints?: { file: string; line: number }[];
}): Promise<string> {
    interface BpLoc { file: string; line: number }
    let specs: BpLoc[];
    if (Array.isArray(args.breakpoints)) {
        specs = args.breakpoints;
    } else {
        specs = [{ file: args.file!, line: args.line! }];
    }
    const results: string[] = [];
    const toRemove: vscode.Breakpoint[] = [];
    for (const spec of specs) {
        const matching = vscode.debug.breakpoints.filter(bp =>
            bp instanceof vscode.SourceBreakpoint &&
            bp.location.uri.fsPath === spec.file &&
            bp.location.range.start.line === spec.line - 1
        );
        if (matching.length === 0) {
            results.push('skip: no breakpoint at ' + spec.file + ':' + spec.line);
        } else {
            toRemove.push(...matching);
            results.push('ok: removed ' + spec.file + ':' + spec.line);
        }
    }
    if (toRemove.length > 0) { await changeBreakpoints(() => vscode.debug.removeBreakpoints(toRemove)); }
    return results.join('\n');
}

export async function removeAllBreakpoints(): Promise<string> {
    const all = vscode.debug.breakpoints;
    if (all.length === 0) { return 'No breakpoints to remove'; }
    await changeBreakpoints(() => vscode.debug.removeBreakpoints([...all]));
    return 'Removed all ' + all.length + ' breakpoint(s)';
}

export async function listBreakpoints(): Promise<string> {
    const bps = vscode.debug.breakpoints.map(bp => {
        if (bp instanceof vscode.SourceBreakpoint) {
            return { type: 'source', file: bp.location.uri.fsPath, line: bp.location.range.start.line + 1, enabled: bp.enabled, condition: bp.condition || undefined, logMessage: bp.logMessage || undefined };
        }
        return { type: 'other', enabled: bp.enabled };
    });
    return JSON.stringify(bps, null, 2);
}

async function startByName(configName: string, folderPath?: string): Promise<string> {
    const files = readLaunchConfigs().filter(f => !folderPath || f.folder.uri.fsPath === folderPath);
    const hasName = (f: LaunchFile) => [...f.configurations, ...f.compounds].some(c => c.name === configName);
    const owner = files.find(hasName);
    if (!owner) {
        const names = files.flatMap(f => [...f.configurations, ...f.compounds].map(c => c.name)).filter(Boolean);
        throw new Error(`no launch configuration named "${configName}". Available: ${names.join(', ') || '(none)'}`);
    }
    const started = await vscode.debug.startDebugging(owner.folder, configName);
    if (!started) { throw new Error(`failed to start "${configName}". Is its debug extension installed?`); }
    return `Debug session "${configName}" started from the launch configuration in ${owner.folder.name}`;
}

export async function startDebug(args: Record<string, unknown>): Promise<string> {
    if (typeof args.configName === 'string' && args.configName) {
        return startByName(args.configName, args.folder as string | undefined);
    }
    const type = args.type as string;
    const request = args.request as string;
    if (!type) { return 'Error: "type" is required (e.g. php, node, python, go, cppdbg, java), or pass "configName"'; }
    if (!request) { return 'Error: "request" is required (launch or attach)'; }
    const config: vscode.DebugConfiguration = { ...args, type, request, name: (args.name as string) || 'Debug (' + type + ')' };
    const folder = vscode.workspace.workspaceFolders?.[0];
    const started = await vscode.debug.startDebugging(folder, config);
    if (!started) { return 'Error: failed to start ' + type + ' debug session. Is the ' + type + ' debug extension installed?'; }
    return 'Debug session "' + config.name + '" started (type: ' + type + ', request: ' + request + ')';
}

export async function stopDebug(): Promise<string> {
    const active = findSession();
    if (!active) { return 'No active debug session'; }
    const session = rootSession(active);
    await vscode.debug.stopDebugging(session);
    return 'Debug session "' + session.name + '" stopped';
}

export async function continueDebug(args: { threadId?: number } = {}): Promise<string> {
    const session = activeSession();
    const threadId = await resolveThread(session, args.threadId);
    await session.customRequest('continue', { threadId });
    return 'Resumed execution. Call debug_wait_for_stop to wait for the next pause.';
}

export async function pauseDebug(args: { threadId?: number } = {}): Promise<string> {
    return resumeAndReport('pause', args.threadId, PAUSE_WAIT_MS);
}

export async function stepOver(args: { threadId?: number } = {}): Promise<string> {
    return resumeAndReport('next', args.threadId, STEP_WAIT_MS);
}

export async function stepInto(args: { threadId?: number } = {}): Promise<string> {
    return resumeAndReport('stepIn', args.threadId, STEP_WAIT_MS);
}

export async function stepOut(args: { threadId?: number } = {}): Promise<string> {
    return resumeAndReport('stepOut', args.threadId, STEP_WAIT_MS);
}

export async function waitForStop(args: { timeoutMs?: number } = {}): Promise<string> {
    return describeWait(await eventHub().waitForStop(args.timeoutMs ?? DEFAULT_STOP_WAIT_MS));
}

export async function getOutput(args: OutputQuery = {}): Promise<string> {
    return JSON.stringify(eventHub().readOutput(args), null, 2);
}

export async function setExceptionBreakpoints(args: { filters?: string[] } = {}): Promise<string> {
    const session = activeSession();
    const available = (eventHub().capabilities(session.id).exceptionBreakpointFilters ?? []) as { filter: string; label: string; default?: boolean }[];
    if (!args.filters) {
        return JSON.stringify({ session: session.name, available }, null, 2);
    }
    const known = new Set(available.map(f => f.filter));
    const unknown = args.filters.filter(f => !known.has(f));
    if (available.length > 0 && unknown.length > 0) {
        throw new Error(`unknown exception filter(s): ${unknown.join(', ')}. Available: ${[...known].join(', ')}`);
    }
    await session.customRequest('setExceptionBreakpoints', { filters: args.filters });
    return `Exception breakpoints for "${session.name}": ${args.filters.join(', ') || '(none)'}. `
        + 'Note: this is not shown in the Breakpoints panel and resets when a new debug session starts.';
}

export async function restartDebug(): Promise<string> {
    const session = vscode.debug.activeDebugSession;
    if (!session) { return 'Error: no active debug session'; }
    try {
        await session.customRequest('restart', {});
        return 'Debug session "' + session.name + '" restarted';
    } catch {
        await vscode.debug.stopDebugging(session);
        return 'Debug session "' + session.name + '" stopped (restart not supported by adapter — use debug_start to start a new session)';
    }
}

export async function evaluate(args: { expression: string; frameId?: number }): Promise<string> {
    const { expression } = args;
    const session = activeSession();
    const frameId = args.frameId ?? await topFrameId(session, await resolveThread(session));
    const response = await session.customRequest('evaluate', { expression, frameId, context: 'repl' });
    return JSON.stringify({ expression, result: response.result, type: response.type || undefined, variablesReference: response.variablesReference || undefined }, null, 2);
}

export async function getVariables(args: { variablesReference?: number; filter?: string }): Promise<string> {
    const { variablesReference, filter } = args;
    const session = activeSession();

    if (!variablesReference) {
        const frameId = await topFrameId(session, await resolveThread(session));
        const scopes = await session.customRequest('scopes', { frameId });
        const result: Record<string, unknown[]> = {};
        for (const scope of scopes.scopes || []) {
            const vars = await session.customRequest('variables', { variablesReference: scope.variablesReference });
            let variables = vars.variables || [];
            if (filter) {
                const lf = filter.toLowerCase();
                variables = variables.filter((v: { name: string }) => v.name.toLowerCase().includes(lf));
            }
            result[scope.name] = variables.map((v: { name: string; value: string; type?: string }) => ({ name: v.name, value: v.value, type: v.type || undefined }));
        }
        return JSON.stringify(result, null, 2);
    }

    const vars = await session.customRequest('variables', { variablesReference });
    const variables = (vars.variables || []).map((v: { name: string; value: string; type?: string; variablesReference?: number }) => ({
        name: v.name, value: v.value, type: v.type || undefined, expandable: (v.variablesReference || 0) > 0, variablesReference: v.variablesReference || undefined,
    }));
    return JSON.stringify(variables, null, 2);
}

export async function getStackTrace(): Promise<string> {
    const session = activeSession();
    const frames = await stackFrames(session, await resolveThread(session), 20);
    return JSON.stringify(frames, null, 2);
}

export async function getLaunchConfigs(): Promise<string> {
    const configs = readLaunchConfigs().map(f => ({
        folder: f.folder.uri.fsPath,
        configurations: f.configurations,
        compounds: f.compounds.length > 0 ? f.compounds : undefined,
    }));
    if (configs.length === 0) { return 'No launch.json configurations found'; }
    return JSON.stringify(configs, null, 2);
}

export async function inspect(args: { variable: string; depth?: number; maxItems?: number }): Promise<string> {
    const { variable } = args;
    const maxDepth = Math.min(args.depth || 2, 5);
    const maxItems = Math.min(args.maxItems || 50, 200);
    const session = activeSession();
    if (!variable) { return 'Error: variable expression is required'; }
    const frameId = await topFrameId(session, await resolveThread(session));

    try {
        const evalResult = await session.customRequest('evaluate', { expression: variable, frameId, context: 'repl' });
        if (evalResult.variablesReference && evalResult.variablesReference > 0) {
            const expanded = await expandVar(session, evalResult.variablesReference, 0, maxDepth, maxItems);
            return JSON.stringify({ variable, type: evalResult.type || undefined, value: expanded }, null, 2);
        }
        return JSON.stringify({ variable, type: evalResult.type || undefined, value: evalResult.result }, null, 2);
    } catch {
        // Fallback: search scopes directly.
        try {
            const scopes = await session.customRequest('scopes', { frameId });
            for (const scope of scopes.scopes || []) {
                const vars = await session.customRequest('variables', { variablesReference: scope.variablesReference });
                for (const v of vars.variables || []) {
                    const vt = v as { name: string; value: string; type?: string; variablesReference?: number };
                    if (vt.name === variable || vt.name === '$' + variable || vt.name === variable.replace(/^\$/, '')) {
                        if (vt.variablesReference && vt.variablesReference > 0) {
                            const expanded = await expandVar(session, vt.variablesReference, 0, maxDepth, maxItems);
                            return JSON.stringify({ variable: vt.name, type: vt.type || undefined, value: expanded }, null, 2);
                        }
                        return JSON.stringify({ variable: vt.name, type: vt.type || undefined, value: vt.value }, null, 2);
                    }
                }
            }
            return 'Variable "' + variable + '" not found in any scope';
        } catch (innerErr: unknown) {
            const msg = innerErr instanceof Error ? innerErr.message : String(innerErr);
            return 'Error inspecting "' + variable + '": ' + msg;
        }
    }
}

export async function watch(args: { action: string; expressions?: string[] }): Promise<string> {
    const { action, expressions } = args;

    switch (action) {
        case 'add': {
            if (!expressions?.length) { return 'Error: expressions array required for add'; }
            for (const expr of expressions) { watchExpressions.add(expr); }
            return 'Watching ' + expressions.length + ' expression(s). Total watches: ' + watchExpressions.size + '\n' + [...watchExpressions].join(', ');
        }
        case 'remove': {
            if (!expressions?.length) { return 'Error: expressions array required for remove'; }
            for (const expr of expressions) { watchExpressions.delete(expr); }
            return 'Removed ' + expressions.length + '. Remaining watches: ' + watchExpressions.size + (watchExpressions.size > 0 ? '\n' + [...watchExpressions].join(', ') : '');
        }
        case 'clear': {
            const count = watchExpressions.size;
            watchExpressions.clear();
            return 'Cleared all ' + count + ' watch expression(s)';
        }
        case 'list': {
            if (watchExpressions.size === 0) { return 'No watch expressions set. Use action="add" first.'; }
            const session = findSession();
            if (!session) { return 'Watch expressions (' + watchExpressions.size + '): ' + [...watchExpressions].join(', ') + '\n(No active debug session — values not available)'; }

            const frameId = await topFrameId(session, await resolveThread(session));
            const results: Record<string, unknown> = {};
            for (const expr of watchExpressions) {
                try {
                    const evalResult = await session.customRequest('evaluate', { expression: expr, frameId, context: 'watch' });
                    if (evalResult.variablesReference && evalResult.variablesReference > 0) {
                        results[expr] = await expandVar(session, evalResult.variablesReference, 0, 1, 20);
                    } else {
                        results[expr] = evalResult.result;
                    }
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    results[expr] = '<error: ' + msg + '>';
                }
            }
            return JSON.stringify(results, null, 2);
        }
        default:
            return 'Error: action must be add, remove, list, or clear';
    }
}
