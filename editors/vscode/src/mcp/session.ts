// Routing policy for one AI session. Each MCP client starts its own MCP
// server process, so one BridgeSession exists per AI session and the
// pinned window belongs to that session only.
//
// Resolution order:
//   1. BLACKBOX_SOCKET, if set.
//   2. The pinned window (same id, or same folders after a reload).
//   3. The single window matching cwd (or BLACKBOX_WORKSPACE).
//   4. The only running window.
// Anything else is a RoutingError; the session never guesses.

import * as path from 'path';
import { IPCResponse, RegistryEntry, STATUS_TOOL, WindowStatus } from '../ipc/protocol';
import { findWindows, matchWindows } from '../ipc/registry';
import { Send, ToolCall, withRetry } from '../ipc/client';

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
    readonly windowCount: number;
}

interface LiveStatus {
    readonly reachable: boolean;
    readonly breakpoints?: number;
    readonly debug?: WindowStatus['debug'];
    readonly statusError?: string; // E.g. a window running an older extension.
}

export interface WindowView extends LiveStatus {
    readonly window: string;
    readonly pid: number;
    readonly folders: readonly string[];
    readonly matchesCwd: boolean;
    readonly selected: boolean;
    readonly lastFocused: boolean;
}

export interface SessionDeps {
    listWindows: () => RegistryEntry[];
    send: Send;
    cwd: string;
    env: NodeJS.ProcessEnv;
}

export function windowLabel(entry: RegistryEntry): string {
    return entry.folders.length > 0 ? path.basename(entry.folders[0]) : `pid ${entry.pid}`;
}

function sameFolders(a: readonly string[], b: readonly string[]): boolean {
    const sortedB = [...b].sort();
    return a.length === b.length && [...a].sort().every((f, i) => f === sortedB[i]);
}

export class BridgeSession {
    private pin: RegistryEntry | undefined;

    constructor(private readonly deps: SessionDeps) {}

    private get dir(): string {
        return this.deps.env.BLACKBOX_WORKSPACE || this.deps.cwd;
    }

    resolve(): Route {
        const windows = this.deps.listWindows();
        const fixed = this.deps.env.BLACKBOX_SOCKET;
        if (fixed) {
            return { socket: fixed, window: windows.find(w => w.socket === fixed), windowCount: windows.length };
        }

        const target = this.pin ? this.pinned(windows, this.pin) : this.automatic(windows);
        return { socket: target.socket, window: target, windowCount: windows.length };
    }

    // A reloaded window gets a new id, so fall back to matching its folders.
    private pinned(windows: RegistryEntry[], pin: RegistryEntry): RegistryEntry {
        const target = windows.find(w => w.id === pin.id) ?? windows.find(w => sameFolders(w.folders, pin.folders));
        if (!target) {
            throw new RoutingError('PIN_GONE', `The selected window (${windowLabel(pin)}) is no longer running.`, windows);
        }
        return target;
    }

    private automatic(windows: RegistryEntry[]): RegistryEntry {
        if (windows.length === 0) {
            throw new RoutingError('NO_WINDOWS', 'No VS Code window with the Blackbox extension is running.', []);
        }
        const matches = matchWindows(windows, this.dir);
        if (matches.length === 1) {
            return matches[0];
        }
        if (matches.length === 0 && windows.length === 1) {
            return windows[0];
        }
        const reason = matches.length === 0
            ? `No VS Code window has ${this.dir} open.`
            : `Several VS Code windows match ${this.dir}.`;
        throw new RoutingError('AMBIGUOUS', reason, matches.length > 1 ? matches : windows);
    }

    // Pins a window for this session; no ref returns to automatic routing.
    select(ref?: string): RegistryEntry | undefined {
        if (!ref) {
            this.pin = undefined;
            return undefined;
        }
        const windows = this.deps.listWindows();
        const found = findWindows(windows, ref);
        if (found.length === 0) {
            throw new RoutingError('NOT_FOUND', `No VS Code window matches "${ref}".`, windows);
        }
        if (found.length > 1) {
            throw new RoutingError('AMBIGUOUS', `Several VS Code windows match "${ref}".`, found);
        }
        this.pin = found[0];
        return found[0];
    }

    async describe(): Promise<WindowView[]> {
        const windows = this.deps.listWindows();
        const matching = new Set(matchWindows(windows, this.dir));
        const lastFocused = Math.max(...windows.map(w => w.focusedAt));
        const current = this.currentWindow();

        return Promise.all(windows.map(async (w): Promise<WindowView> => ({
            window: w.id,
            pid: w.pid,
            folders: w.folders,
            matchesCwd: matching.has(w),
            selected: current?.id === w.id,
            lastFocused: w.focusedAt === lastFocused,
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
        try {
            const resp = await this.deps.send(window.socket, { tool: STATUS_TOOL, args: {}, timeoutMs: STATUS_TIMEOUT_MS });
            if (resp.error || !resp.result) {
                return { reachable: false, statusError: resp.error ?? 'empty status' };
            }
            const status: WindowStatus = JSON.parse(resp.result);
            return { reachable: true, breakpoints: status.breakpoints, debug: status.debug };
        } catch (err: unknown) {
            return { reachable: false, statusError: err instanceof Error ? err.message : String(err) };
        }
    }
}
