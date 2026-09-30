// Routing policy for one AI session. Each MCP client starts its own MCP
// server process, so one BridgeSession exists per AI session and the
// pinned window belongs to that session only.
//
// Resolution order:
//   1. BLACKBOX_SOCKET, if set.
//   2. The pinned window (same id, or same folders after a reload).
//   3. The single window matching cwd (or BLACKBOX_WORKSPACE).
//   4. Several match: the one the AI was launched from (window, then editor).
//   5. None match: the window the AI was launched from, or the only window.
// Anything else is a RoutingError; the session never guesses.

import * as path from 'path';
import { AppInfo, IPCResponse, PROTOCOL_VERSION, RegistryEntry, STATUS_TOOL, WindowStatus } from '../ipc/protocol';
import { findWindows, matchWindows } from '../ipc/registry';
import { Send, ToolCall, withRetry } from '../ipc/client';
import { LaunchInfo, detectLaunch } from './launch';

const STATUS_TIMEOUT_MS = 2000;

export type RoutingCode = 'NO_WINDOWS' | 'AMBIGUOUS' | 'PIN_GONE' | 'NOT_FOUND';

export class RoutingError extends Error {
    constructor(readonly code: RoutingCode, message: string, readonly candidates: readonly RegistryEntry[]) {
        super(message);
    }
}

export interface Route {
    readonly socket: string;
    readonly window?: RegistryEntry; // Undefined when BLACKBOX_SOCKET pins a path.
    readonly windows: readonly RegistryEntry[]; // Every running window, for labelling.
}

interface LiveStatus {
    readonly reachable: boolean;
    readonly breakpoints?: number;
    readonly debug?: WindowStatus['debug'];
    readonly statusError?: string;
}

export interface WindowView extends LiveStatus {
    readonly window: string;
    readonly pid: number;
    readonly app: AppInfo;
    readonly extensionVersion: string;
    readonly outdated: boolean;
    readonly folders: readonly string[];
    readonly matchesCwd: boolean;
    readonly selected: boolean;
    readonly lastFocused: boolean;
    readonly launchedFrom: 'window' | 'app' | null;
}

export interface SessionDeps {
    listWindows: () => RegistryEntry[];
    send: Send;
    cwd: string;
    env: NodeJS.ProcessEnv;
    ancestors: readonly number[]; // This MCP server's parent processes, nearest first.
}

// Folder name, plus the editor when windows from several editors are running.
export function windowLabel(entry: RegistryEntry, windows: readonly RegistryEntry[] = []): string {
    const name = entry.folders.length > 0 ? path.basename(entry.folders[0]) : `pid ${entry.pid}`;
    // Older windows don't report an editor, so they don't count as another one.
    const editors = new Set(windows.filter(w => w.protocol >= PROTOCOL_VERSION).map(w => w.app.name));
    return editors.size > 1 && entry.protocol >= PROTOCOL_VERSION ? `${name} (${entry.app.name})` : name;
}

function sameFolders(a: readonly string[], b: readonly string[]): boolean {
    const sortedB = [...b].sort();
    return a.length === b.length && [...a].sort().every((f, i) => f === sortedB[i]);
}

function launchedFrom(launch: LaunchInfo, window: RegistryEntry): WindowView['launchedFrom'] {
    if (launch.window?.id === window.id) {
        return 'window';
    }
    return launch.appPid !== undefined && launch.appPid === window.appPid ? 'app' : null;
}

export class BridgeSession {
    private pin: RegistryEntry | undefined;

    constructor(private readonly deps: SessionDeps) {}

    private get dir(): string {
        return this.deps.env.BLACKBOX_WORKSPACE || this.deps.cwd;
    }

    private launch(windows: readonly RegistryEntry[]): LaunchInfo {
        return detectLaunch(windows, this.deps.ancestors, this.deps.env);
    }

    resolve(): Route {
        const windows = this.deps.listWindows();
        const fixed = this.deps.env.BLACKBOX_SOCKET;
        if (fixed) {
            return { socket: fixed, window: windows.find(w => w.socket === fixed), windows };
        }

        const target = this.pin ? this.pinned(windows, this.pin) : this.automatic(windows);
        return { socket: target.socket, window: target, windows };
    }

    // A reloaded window gets a new id, so fall back to the window with the
    // same folders in the same editor (never another editor's window).
    private pinned(windows: RegistryEntry[], pin: RegistryEntry): RegistryEntry {
        const target = windows.find(w => w.id === pin.id)
            ?? windows.find(w => w.app.name === pin.app.name && sameFolders(w.folders, pin.folders));
        if (!target) {
            throw new RoutingError('PIN_GONE', `The selected window (${windowLabel(pin, windows)}) is no longer running.`, windows);
        }
        return target;
    }

    private automatic(windows: RegistryEntry[]): RegistryEntry {
        if (windows.length === 0) {
            throw new RoutingError('NO_WINDOWS', 'No editor window with the Blackbox extension is running.', []);
        }
        const matches = matchWindows(windows, this.dir);
        if (matches.length === 1) {
            return matches[0];
        }

        const launch = this.launch(windows);
        if (matches.length > 1) {
            const fromLaunch = launch.window && matches.find(m => m.id === launch.window!.id);
            const inEditor = matches.filter(m => launch.appPid !== undefined && m.appPid === launch.appPid);
            const chosen = fromLaunch ?? (inEditor.length === 1 ? inEditor[0] : undefined);
            if (chosen) {
                return chosen;
            }
            throw new RoutingError('AMBIGUOUS', `Several editor windows match ${this.dir}.`, matches);
        }

        // Nothing matches cwd, so it can't point anywhere else.
        const fallback = launch.window ?? (windows.length === 1 ? windows[0] : undefined);
        if (fallback) {
            return fallback;
        }
        throw new RoutingError('AMBIGUOUS', `No editor window has ${this.dir} open.`, windows);
    }

    // Pins a window for this session; no ref returns to automatic routing.
    select(ref?: string, app?: string): RegistryEntry | undefined {
        if (!ref) {
            this.pin = undefined;
            return undefined;
        }
        const windows = this.deps.listWindows();
        const found = findWindows(windows, ref, app);
        const target = app ? `"${ref}" in ${app}` : `"${ref}"`;
        if (found.length === 0) {
            throw new RoutingError('NOT_FOUND', `No editor window matches ${target}.`, windows);
        }
        if (found.length > 1) {
            throw new RoutingError('AMBIGUOUS', `Several editor windows match ${target}.`, found);
        }
        this.pin = found[0];
        return found[0];
    }

    // Describes `subset` (default: every window) with live status.
    async describe(subset?: readonly RegistryEntry[]): Promise<WindowView[]> {
        const windows = this.deps.listWindows();
        const matching = new Set(matchWindows(windows, this.dir).map(w => w.id));
        const lastFocused = Math.max(...windows.map(w => w.focusedAt));
        const launch = this.launch(windows);
        const current = this.currentWindow();

        return Promise.all((subset ?? windows).map(async (w): Promise<WindowView> => ({
            window: w.id,
            pid: w.pid,
            app: w.app,
            extensionVersion: w.extensionVersion,
            outdated: w.protocol < PROTOCOL_VERSION,
            folders: w.folders,
            matchesCwd: matching.has(w.id),
            selected: current?.id === w.id,
            lastFocused: w.focusedAt === lastFocused,
            launchedFrom: launchedFrom(launch, w),
            ...await this.fetchStatus(w),
        })));
    }

    call(call: ToolCall): Promise<{ route: Route; resp: IPCResponse }> {
        return withRetry(async () => {
            const route = this.resolve();
            const resp = await this.deps.send(route.socket, call);
            return { route, resp };
        });
    }

    // The window calls would go to right now, if routing can decide.
    private currentWindow(): RegistryEntry | undefined {
        try {
            return this.resolve().window;
        } catch (err: unknown) {
            if (err instanceof RoutingError) {
                return undefined;
            }
            throw err;
        }
    }

    private async fetchStatus(window: RegistryEntry): Promise<LiveStatus> {
        const outdatedHint = window.protocol < PROTOCOL_VERSION
            ? ' (this window runs an older Blackbox extension; reload it after updating)'
            : '';
        try {
            const resp = await this.deps.send(window.socket, { tool: STATUS_TOOL, args: {}, timeoutMs: STATUS_TIMEOUT_MS });
            if (resp.error || !resp.result) {
                return { reachable: false, statusError: (resp.error ?? 'empty status') + outdatedHint };
            }
            const status: WindowStatus = JSON.parse(resp.result);
            return { reachable: true, breakpoints: status.breakpoints, debug: status.debug };
        } catch (err: unknown) {
            return { reachable: false, statusError: (err instanceof Error ? err.message : String(err)) + outdatedHint };
        }
    }
}
