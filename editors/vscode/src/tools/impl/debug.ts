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

interface FrameTarget { threadId?: number; frameId?: number }

// The frame to inspect: the one asked for, else the top of the chosen thread.
async function frameIdFor(session: vscode.DebugSession, target: FrameTarget = {}): Promise<number> {
    if (target.frameId !== undefined) { return target.frameId; }
    return topFrameId(session, await resolveThread(session, target.threadId));
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

interface BpSpec { file: string; line: number; condition?: string; hitCondition?: string; logMessage?: string }
interface BpLoc { file: string; line: number }

function describeSpec(spec: BpSpec): string {
    return spec.file + ':' + spec.line
        + (spec.condition ? ' (if: ' + spec.condition + ')' : '')
        + (spec.hitCondition ? ' (hits: ' + spec.hitCondition + ')' : '')
        + (spec.logMessage ? ' (log: ' + spec.logMessage + ')' : '');
}

function sourceBreakpointsAt(loc: BpLoc): vscode.SourceBreakpoint[] {
    return vscode.debug.breakpoints.filter((bp): bp is vscode.SourceBreakpoint =>
        bp instanceof vscode.SourceBreakpoint &&
        bp.location.uri.fsPath === loc.file &&
        bp.location.range.start.line === loc.line - 1);
}

function functionBreakpointsNamed(name: string): vscode.FunctionBreakpoint[] {
    return vscode.debug.breakpoints.filter((bp): bp is vscode.FunctionBreakpoint =>
        bp instanceof vscode.FunctionBreakpoint && bp.functionName === name);
}

// Breakpoint properties are read-only in VS Code, so changing one means
// replacing it with a copy.
function withEnabled(bp: vscode.Breakpoint, enabled: boolean): vscode.Breakpoint {
    if (bp instanceof vscode.SourceBreakpoint) {
        return new vscode.SourceBreakpoint(bp.location, enabled, bp.condition, bp.hitCondition, bp.logMessage);
    }
    if (bp instanceof vscode.FunctionBreakpoint) {
        return new vscode.FunctionBreakpoint(bp.functionName, enabled, bp.condition, bp.hitCondition, bp.logMessage);
    }
    throw new Error('only source and function breakpoints can be enabled or disabled');
}

// A note when the active debug adapter says it can't honour a feature.
function unsupportedNote(capability: string, feature: string): string {
    const session = findSession();
    if (!session || !events) { return ''; }
    const caps = events.capabilities(session.id);
    return Object.keys(caps).length > 0 && !caps[capability]
        ? `\nnote: the "${session.type}" debug adapter does not support ${feature}; it may be ignored`
        : '';
}

export async function setBreakpoint(args: BpSpec & { breakpoints?: BpSpec[] }): Promise<string> {
    const specs: BpSpec[] = Array.isArray(args.breakpoints)
        ? args.breakpoints
        : [{ file: args.file, line: args.line, condition: args.condition, hitCondition: args.hitCondition, logMessage: args.logMessage }];
    const results: string[] = [];
    const bps: vscode.SourceBreakpoint[] = [];
    for (const spec of specs) {
        if (!spec.file || !spec.line || spec.line < 1) {
            results.push('skip: invalid — file and line (>= 1) required');
            continue;
        }
        const location = new vscode.Location(vscode.Uri.file(spec.file), new vscode.Position(spec.line - 1, 0));
        bps.push(new vscode.SourceBreakpoint(location, true, spec.condition, spec.hitCondition, spec.logMessage));
        results.push('ok: ' + describeSpec(spec));
    }
    if (bps.length > 0) { await changeBreakpoints(() => vscode.debug.addBreakpoints(bps)); }
    const note = specs.some(s => s.hitCondition) ? unsupportedNote('supportsHitConditionalBreakpoints', 'hit conditions') : '';
    return results.join('\n') + note;
}

export async function setFunctionBreakpoint(args: { name: string; condition?: string; hitCondition?: string; logMessage?: string }): Promise<string> {
    if (!args.name) { throw new Error('function name is required'); }
    const bp = new vscode.FunctionBreakpoint(args.name, true, args.condition, args.hitCondition, args.logMessage);
    await changeBreakpoints(() => vscode.debug.addBreakpoints([bp]));
    return 'ok: function ' + args.name
        + (args.condition ? ' (if: ' + args.condition + ')' : '')
        + (args.hitCondition ? ' (hits: ' + args.hitCondition + ')' : '')
        + unsupportedNote('supportsFunctionBreakpoints', 'function breakpoints');
}

export async function removeBreakpoint(args: BpLoc & { breakpoints?: BpLoc[]; functions?: string[] }): Promise<string> {
    const specs: BpLoc[] = Array.isArray(args.breakpoints)
        ? args.breakpoints
        : args.file ? [{ file: args.file, line: args.line }] : [];
    const results: string[] = [];
    const toRemove: vscode.Breakpoint[] = [];
    for (const spec of specs) {
        const matching = sourceBreakpointsAt(spec);
        results.push(matching.length === 0 ? 'skip: no breakpoint at ' + spec.file + ':' + spec.line : 'ok: removed ' + spec.file + ':' + spec.line);
        toRemove.push(...matching);
    }
    for (const name of args.functions ?? []) {
        const matching = functionBreakpointsNamed(name);
        results.push(matching.length === 0 ? 'skip: no function breakpoint on ' + name : 'ok: removed function ' + name);
        toRemove.push(...matching);
    }
    if (toRemove.length > 0) { await changeBreakpoints(() => vscode.debug.removeBreakpoints(toRemove)); }
    return results.join('\n') || 'Nothing to remove: pass file+line, breakpoints or functions';
}

export async function toggleBreakpoints(args: { enabled: boolean; breakpoints?: BpLoc[]; functions?: string[] }): Promise<string> {
    if (typeof args.enabled !== 'boolean') { throw new Error('"enabled" (true or false) is required'); }
    const targets = [
        ...(args.breakpoints ?? []).flatMap(sourceBreakpointsAt),
        ...(args.functions ?? []).flatMap(functionBreakpointsNamed),
    ];
    const all = !args.breakpoints && !args.functions;
    const chosen = all ? [...vscode.debug.breakpoints] : targets;
    const changing = chosen.filter(bp => bp.enabled !== args.enabled);
    if (changing.length > 0) {
        const replacements = changing.map(bp => withEnabled(bp, args.enabled));
        await changeBreakpoints(() => {
            vscode.debug.removeBreakpoints(changing);
            vscode.debug.addBreakpoints(replacements);
        });
    }
    return `${args.enabled ? 'Enabled' : 'Disabled'} ${changing.length} breakpoint(s)`
        + (chosen.length > changing.length ? `; ${chosen.length - changing.length} already ${args.enabled ? 'enabled' : 'disabled'}` : '')
        + (chosen.length === 0 ? '. No matching breakpoints.' : '');
}

export async function removeAllBreakpoints(): Promise<string> {
    const all = vscode.debug.breakpoints;
    if (all.length === 0) { return 'No breakpoints to remove'; }
    await changeBreakpoints(() => vscode.debug.removeBreakpoints([...all]));
    return 'Removed all ' + all.length + ' breakpoint(s)';
}

export async function listBreakpoints(): Promise<string> {
    const bps = vscode.debug.breakpoints.map(bp => {
        const common = { enabled: bp.enabled, condition: bp.condition || undefined, hitCondition: bp.hitCondition || undefined, logMessage: bp.logMessage || undefined };
        if (bp instanceof vscode.SourceBreakpoint) {
            return { type: 'source', file: bp.location.uri.fsPath, line: bp.location.range.start.line + 1, ...common };
        }
        if (bp instanceof vscode.FunctionBreakpoint) {
            return { type: 'function', name: bp.functionName, ...common };
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

export async function waitForStop(args: { timeoutMs?: number; next?: boolean } = {}): Promise<string> {
    return describeWait(await eventHub().waitForStop(args.timeoutMs ?? DEFAULT_STOP_WAIT_MS, { next: args.next }));
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

export async function evaluate(args: FrameTarget & { expression: string }): Promise<string> {
    const { expression } = args;
    const session = activeSession();
    const frameId = await frameIdFor(session, args);
    const response = await session.customRequest('evaluate', { expression, frameId, context: 'repl' });
    return JSON.stringify({ expression, result: response.result, type: response.type || undefined, variablesReference: response.variablesReference || undefined }, null, 2);
}

export async function getVariables(args: FrameTarget & { variablesReference?: number; filter?: string }): Promise<string> {
    const { variablesReference, filter } = args;
    const session = activeSession();

    if (!variablesReference) {
        const frameId = await frameIdFor(session, args);
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

export async function getStackTrace(args: { threadId?: number; levels?: number } = {}): Promise<string> {
    const session = activeSession();
    const frames = await stackFrames(session, await resolveThread(session, args.threadId), Math.min(args.levels ?? 20, 200));
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

export async function inspect(args: FrameTarget & { variable: string; depth?: number; maxItems?: number }): Promise<string> {
    const { variable } = args;
    const maxDepth = Math.min(args.depth || 2, 5);
    const maxItems = Math.min(args.maxItems || 50, 200);
    const session = activeSession();
    if (!variable) { return 'Error: variable expression is required'; }
    const frameId = await frameIdFor(session, args);

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

export async function watch(args: FrameTarget & { action: string; expressions?: string[] }): Promise<string> {
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

            const frameId = await frameIdFor(session, args);
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

export async function listThreads(): Promise<string> {
    const session = activeSession();
    const response = await session.customRequest('threads', {});
    const paused = new Set(events?.pausedThreads(session.id));
    const threads = (response.threads || []).map((t: { id: number; name: string }) => ({
        id: t.id, name: t.name, stopped: paused.has(t.id) || undefined,
    }));
    return JSON.stringify({ session: session.name, threads }, null, 2);
}

interface DapVariable { name: string; value: string; type?: string; variablesReference?: number }

// The scope reference holding `name` in the given frame, if any.
async function scopeContaining(session: vscode.DebugSession, frameId: number, name: string): Promise<number | undefined> {
    const scopes = await session.customRequest('scopes', { frameId });
    for (const scope of scopes.scopes || []) {
        const vars = await session.customRequest('variables', { variablesReference: scope.variablesReference });
        if ((vars.variables || []).some((v: DapVariable) => v.name === name)) {
            return scope.variablesReference;
        }
    }
    return undefined;
}

export async function setVariable(args: FrameTarget & { name: string; value: string; variablesReference?: number }): Promise<string> {
    const { name, value } = args;
    if (!name || value === undefined) { throw new Error('"name" and "value" are required'); }
    const session = activeSession();
    const caps = eventHub().capabilities(session.id);
    const frameId = await frameIdFor(session, args);

    if (caps.supportsSetVariable) {
        const ref = args.variablesReference ?? await scopeContaining(session, frameId, name);
        if (ref !== undefined) {
            const result = await session.customRequest('setVariable', { variablesReference: ref, name, value });
            return JSON.stringify({ name, value: result.value, type: result.type || undefined }, null, 2);
        }
    }
    if (caps.supportsSetExpression) {
        const result = await session.customRequest('setExpression', { expression: name, value, frameId });
        return JSON.stringify({ name, value: result.value, type: result.type || undefined }, null, 2);
    }
    throw new Error(caps.supportsSetVariable
        ? `no variable named "${name}" in the current frame; pass variablesReference for a nested one`
        : `the "${session.type}" debug adapter cannot change variables`);
}

export async function runToLine(args: { file: string; line: number; timeoutMs?: number; threadId?: number }): Promise<string> {
    if (!args.file || !args.line || args.line < 1) { throw new Error('file and line (>= 1) are required'); }
    const session = activeSession();
    const target = { file: args.file, line: args.line };
    const existing = sourceBreakpointsAt(target).length > 0;
    const temporary = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(args.file), new vscode.Position(args.line - 1, 0)));

    if (!existing) { await changeBreakpoints(() => vscode.debug.addBreakpoints([temporary])); }
    try {
        const wait = eventHub().arm();
        await session.customRequest('continue', { threadId: await resolveThread(session, args.threadId) });
        const result = await wait(args.timeoutMs ?? DEFAULT_STOP_WAIT_MS);
        const report = JSON.parse(await describeWait(result));
        report.reachedTarget = report.state === 'stopped' && report.line === args.line && report.file === args.file;
        return JSON.stringify(report, null, 2);
    } finally {
        if (!existing) { await changeBreakpoints(() => vscode.debug.removeBreakpoints([temporary])); }
    }
}

export async function getSourceContext(args: FrameTarget & { lines?: number } = {}): Promise<string> {
    const session = activeSession();
    const radius = Math.min(Math.max(args.lines ?? 5, 0), 50);
    const threadId = await resolveThread(session, args.threadId);
    const frames = await stackFrames(session, threadId, 200);
    const frame = args.frameId !== undefined ? frames.find(f => f.id === args.frameId) : frames[0];
    if (!frame) { throw new Error('no such stack frame — is the debugger stopped at a breakpoint?'); }

    // Through VS Code, so unsaved edits are included.
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(frame.file));
    const first = Math.max(1, frame.line - radius);
    const last = Math.min(doc.lineCount, frame.line + radius);
    const lines = [];
    for (let n = first; n <= last; n++) {
        lines.push({ line: n, text: doc.lineAt(n - 1).text, current: n === frame.line || undefined });
    }
    return JSON.stringify({ file: frame.file, line: frame.line, function: frame.name, lines }, null, 2);
}
