// Core debug tool implementations.
// Called by both languageModelTools (tools/debug.ts) and IPC handlers (ipc/handlers.ts).
// All logic uses VS Code Debug Adapter Protocol (DAP) — language-agnostic.

import * as vscode from 'vscode';

// ── Helpers ─────────────────────────────────────────────────────

export async function getThreadId(session: vscode.DebugSession): Promise<number | null> {
    const threads = await session.customRequest('threads', {});
    return threads.threads?.[0]?.id ?? null;
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
    if (bps.length > 0) { vscode.debug.addBreakpoints(bps); }
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
    if (toRemove.length > 0) { vscode.debug.removeBreakpoints(toRemove); }
    return results.join('\n');
}

export async function removeAllBreakpoints(): Promise<string> {
    const all = vscode.debug.breakpoints;
    if (all.length === 0) { return 'No breakpoints to remove'; }
    vscode.debug.removeBreakpoints([...all]);
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

export async function startDebug(args: Record<string, unknown>): Promise<string> {
    const type = args.type as string;
    const request = args.request as string;
    if (!type) { return 'Error: "type" is required (e.g. php, node, python, go, cppdbg, java)'; }
    if (!request) { return 'Error: "request" is required (launch or attach)'; }
    const config: vscode.DebugConfiguration = { ...args, type, request, name: (args.name as string) || 'Debug (' + type + ')' };
    const folder = vscode.workspace.workspaceFolders?.[0];
    const started = await vscode.debug.startDebugging(folder, config);
    if (!started) { return 'Error: failed to start ' + type + ' debug session. Is the ' + type + ' debug extension installed?'; }
    return 'Debug session "' + config.name + '" started (type: ' + type + ', request: ' + request + ')';
}

export async function stopDebug(): Promise<string> {
    const session = vscode.debug.activeDebugSession;
    if (!session) { return 'No active debug session'; }
    await vscode.debug.stopDebugging(session);
    return 'Debug session "' + session.name + '" stopped';
}

export async function continueDebug(): Promise<string> {
    const session = vscode.debug.activeDebugSession;
    if (!session) { return 'Error: no active debug session'; }
    const threadId = await getThreadId(session);
    if (!threadId) { return 'Error: no threads'; }
    await session.customRequest('continue', { threadId });
    return 'Resumed execution';
}

export async function pauseDebug(): Promise<string> {
    const session = vscode.debug.activeDebugSession;
    if (!session) { return 'Error: no active debug session'; }
    const threadId = await getThreadId(session);
    if (!threadId) { return 'Error: no threads'; }
    await session.customRequest('pause', { threadId });
    return 'Paused execution';
}

export async function stepOver(): Promise<string> {
    const session = vscode.debug.activeDebugSession;
    if (!session) { return 'Error: no active debug session'; }
    const threadId = await getThreadId(session);
    if (!threadId) { return 'Error: no threads'; }
    await session.customRequest('next', { threadId });
    return 'Stepped over to next line';
}

export async function stepInto(): Promise<string> {
    const session = vscode.debug.activeDebugSession;
    if (!session) { return 'Error: no active debug session'; }
    const threadId = await getThreadId(session);
    if (!threadId) { return 'Error: no threads'; }
    await session.customRequest('stepIn', { threadId });
    return 'Stepped into function';
}

export async function stepOut(): Promise<string> {
    const session = vscode.debug.activeDebugSession;
    if (!session) { return 'Error: no active debug session'; }
    const threadId = await getThreadId(session);
    if (!threadId) { return 'Error: no threads'; }
    await session.customRequest('stepOut', { threadId });
    return 'Stepped out of function';
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
    let frameId = args.frameId;
    const session = vscode.debug.activeDebugSession;
    if (!session) { return 'Error: no active debug session'; }
    if (frameId === undefined) {
        const threadId = await getThreadId(session);
        if (!threadId) { return 'Error: no threads — is the debugger stopped at a breakpoint?'; }
        const stack = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 });
        if (!stack.stackFrames?.length) { return 'Error: no stack frames'; }
        frameId = stack.stackFrames[0].id;
    }
    const response = await session.customRequest('evaluate', { expression, frameId, context: 'repl' });
    return JSON.stringify({ expression, result: response.result, type: response.type || undefined, variablesReference: response.variablesReference || undefined }, null, 2);
}

export async function getVariables(args: { variablesReference?: number; filter?: string }): Promise<string> {
    const { variablesReference, filter } = args;
    const session = vscode.debug.activeDebugSession;
    if (!session) { return 'Error: no active debug session'; }

    let ref = variablesReference;
    if (!ref) {
        const threadId = await getThreadId(session);
        if (!threadId) { return 'No threads — is the debugger stopped at a breakpoint?'; }
        const stack = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 });
        if (!stack.stackFrames?.length) { return 'No stack frames — is the debugger stopped at a breakpoint?'; }
        const scopes = await session.customRequest('scopes', { frameId: stack.stackFrames[0].id });
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

    const vars = await session.customRequest('variables', { variablesReference: ref });
    const variables = (vars.variables || []).map((v: { name: string; value: string; type?: string; variablesReference?: number }) => ({
        name: v.name, value: v.value, type: v.type || undefined, expandable: (v.variablesReference || 0) > 0, variablesReference: v.variablesReference || undefined,
    }));
    return JSON.stringify(variables, null, 2);
}

export async function getStackTrace(): Promise<string> {
    const session = vscode.debug.activeDebugSession;
    if (!session) { return 'Error: no active debug session'; }
    const threadId = await getThreadId(session);
    if (!threadId) { return 'No threads'; }
    const stack = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 20 });
    const frames = (stack.stackFrames || []).map((f: { id: number; name: string; line: number; source?: { path?: string; name?: string } }) => ({
        id: f.id, name: f.name, file: f.source?.path || f.source?.name || '(unknown)', line: f.line,
    }));
    return JSON.stringify(frames, null, 2);
}

export async function getLaunchConfigs(): Promise<string> {
    const fs = await import('fs');
    const path = await import('path');
    const folders = vscode.workspace.workspaceFolders || [];
    const configs: { folder: string; configurations: unknown[] }[] = [];
    for (const folder of folders) {
        const launchPath = path.join(folder.uri.fsPath, '.vscode', 'launch.json');
        try {
            const raw = fs.readFileSync(launchPath, 'utf-8');
            const cleaned = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
            const parsed = JSON.parse(cleaned);
            configs.push({ folder: folder.uri.fsPath, configurations: parsed.configurations || [] });
        } catch { /* no launch.json */ }
    }
    if (configs.length === 0) { return 'No launch.json configurations found'; }
    return JSON.stringify(configs, null, 2);
}

export async function inspect(args: { variable: string; depth?: number; maxItems?: number }): Promise<string> {
    const { variable } = args;
    const maxDepth = Math.min(args.depth || 2, 5);
    const maxItems = Math.min(args.maxItems || 50, 200);
    const session = vscode.debug.activeDebugSession;
    if (!session) { return 'Error: no active debug session'; }
    if (!variable) { return 'Error: variable expression is required'; }

    try {
        const threadId = await getThreadId(session);
        if (!threadId) { return 'Error: no threads — is the debugger stopped at a breakpoint?'; }
        const stack = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 });
        if (!stack.stackFrames?.length) { return 'Error: no stack frames'; }

        const evalResult = await session.customRequest('evaluate', {
            expression: variable, frameId: stack.stackFrames[0].id, context: 'repl',
        });

        if (evalResult.variablesReference && evalResult.variablesReference > 0) {
            const expanded = await expandVar(session, evalResult.variablesReference, 0, maxDepth, maxItems);
            return JSON.stringify({ variable, type: evalResult.type || undefined, value: expanded }, null, 2);
        }
        return JSON.stringify({ variable, type: evalResult.type || undefined, value: evalResult.result }, null, 2);
    } catch {
        // Fallback: search scopes directly.
        try {
            const threadId = await getThreadId(session);
            if (!threadId) { return 'Error: no threads'; }
            const stack = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 });
            if (!stack.stackFrames?.length) { return 'Error: no stack frames'; }
            const scopes = await session.customRequest('scopes', { frameId: stack.stackFrames[0].id });

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
            const session = vscode.debug.activeDebugSession;
            if (!session) { return 'Watch expressions (' + watchExpressions.size + '): ' + [...watchExpressions].join(', ') + '\n(No active debug session — values not available)'; }

            const threadId = await getThreadId(session);
            if (!threadId) { return 'Watch expressions set but no threads — is the debugger running?'; }

            const stack = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 });
            const frameId = stack.stackFrames?.[0]?.id;

            const results: Record<string, unknown> = {};
            for (const expr of watchExpressions) {
                try {
                    const evalResult = await session.customRequest('evaluate', { expression: expr, frameId: frameId || 0, context: 'watch' });
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
