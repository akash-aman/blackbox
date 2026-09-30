// Tracks Debug Adapter Protocol traffic for every debug session, so tools can
// wait for the debugger to pause and read program output. No vscode import:
// events.ts feeds it from a DebugAdapterTracker, tests feed it directly.
//
// Waiting is across all sessions because some adapters (e.g. js-debug for
// Node) report pauses on a child session, not the one that was started.

export interface StopEvent {
    readonly reason: string;
    readonly threadId?: number;
    readonly description?: string;
    readonly text?: string;
}

export interface OutputEntry {
    readonly seq: number;
    readonly session: string;
    readonly category: string;
    readonly text: string;
}

export interface OutputQuery {
    readonly since?: number;    // Only entries after this sequence number.
    readonly category?: string; // stdout, stderr, console, important.
    readonly match?: string;    // Case-insensitive substring of the text.
    readonly limit?: number;    // Maximum entries.
}

export interface OutputPage {
    readonly entries: OutputEntry[];
    readonly nextSince: number; // Pass as `since` to continue.
    readonly more: boolean;     // Entries were left out by limit or size.
}

export type WaitResult<S> =
    | { readonly kind: 'stopped'; readonly session: S; readonly stop: StopEvent }
    | { readonly kind: 'timeout' }
    | { readonly kind: 'terminated' };

export interface TrackerHandlers {
    onDidSendMessage(message: any): void;     // Adapter -> editor: events and responses.
    onWillReceiveMessage(message: any): void; // Editor -> adapter: requests.
    onWillStopSession(): void;
    onExit(): void;
}

interface Tracked<S> {
    readonly session: S;
    readonly pendingRequests: Map<number, string>; // Request seq -> command.
    capabilities: Record<string, unknown>;
    lastStop?: StopEvent;
    stoppedAt: number; // Ordering of stops across sessions; 0 = running.
    ended: boolean;
}

type Listener<S> = (result: WaitResult<S>) => void;
type ResponseListener = (command: string) => void;

// Requests after which the program runs until the next stopped event.
const RESUMING_REQUESTS = new Set(['continue', 'next', 'stepIn', 'stepOut', 'stepBack', 'reverseContinue', 'goto', 'restartFrame']);

const DEFAULT_OUTPUT_LIMIT = 200;
// Some adapters log their own protocol traffic as output (e.g. php-debug
// with "log": true, one message can be megabytes), so keep responses small.
const MAX_ENTRY_CHARS = 2_000;
const MAX_OUTPUT_CHARS = 50_000;

export class DebugEvents<S extends { readonly id: string; readonly name: string }> {
    private readonly sessions = new Map<string, Tracked<S>>();
    private readonly listeners = new Set<Listener<S>>();
    private readonly responseListeners = new Set<ResponseListener>();
    private output: OutputEntry[] = [];
    private outputSeq = 0;
    private stopCounter = 0;

    constructor(private readonly maxOutput = 1000) {}

    track(session: S): TrackerHandlers {
        const tracked: Tracked<S> = { session, pendingRequests: new Map(), capabilities: {}, stoppedAt: 0, ended: false };
        this.sessions.set(session.id, tracked);
        return {
            onDidSendMessage: message => this.onAdapterMessage(tracked, message),
            onWillReceiveMessage: message => {
                if (message?.type !== 'request') {
                    return;
                }
                tracked.pendingRequests.set(message.seq, message.command);
                if (RESUMING_REQUESTS.has(message.command)) {
                    tracked.stoppedAt = 0;
                }
            },
            onWillStopSession: () => this.end(tracked),
            onExit: () => this.end(tracked),
        };
    }

    capabilities(sessionId: string): Record<string, unknown> {
        return this.sessions.get(sessionId)?.capabilities ?? {};
    }

    lastStop(sessionId: string): StopEvent | undefined {
        return this.sessions.get(sessionId)?.lastStop;
    }

    isPaused(sessionId: string): boolean {
        const tracked = this.sessions.get(sessionId);
        return !!tracked && !tracked.ended && tracked.stoppedAt > 0;
    }

    // The most recent pause among sessions that are still paused.
    currentStop(): { session: S; stop: StopEvent } | undefined {
        const paused = [...this.sessions.values()].filter(t => !t.ended && t.stoppedAt > 0 && t.lastStop);
        const latest = paused.sort((a, b) => b.stoppedAt - a.stoppedAt)[0];
        return latest && { session: latest.session, stop: latest.lastStop! };
    }

    // Starts listening now, before a request is sent, so a fast pause is not
    // missed. Call the returned function to wait for the result.
    arm(): (timeoutMs: number) => Promise<WaitResult<S>> {
        let early: WaitResult<S> | undefined = this.hasLiveSession() ? undefined : { kind: 'terminated' };
        let deliver: Listener<S> | undefined;
        const listener: Listener<S> = result => {
            this.listeners.delete(listener);
            if (deliver) {
                deliver(result);
            } else {
                early = result;
            }
        };
        if (!early) {
            this.listeners.add(listener);
        }

        return timeoutMs => new Promise(resolve => {
            if (early) {
                resolve(early);
                return;
            }
            const timer = setTimeout(() => {
                this.listeners.delete(listener);
                resolve({ kind: 'timeout' });
            }, timeoutMs);
            deliver = result => {
                clearTimeout(timer);
                resolve(result);
            };
        });
    }

    // Starts listening for the adapter's response to the next `command`
    // request from any session. The returned function resolves true when it
    // arrives, false on timeout, or at once with false if no session is live.
    armResponse(command: string): (timeoutMs: number) => Promise<boolean> {
        if (!this.hasLiveSession()) {
            return async () => false;
        }
        let seen = false;
        let deliver: (() => void) | undefined;
        const listener: ResponseListener = responded => {
            if (responded !== command) {
                return;
            }
            this.responseListeners.delete(listener);
            seen = true;
            deliver?.();
        };
        this.responseListeners.add(listener);

        return timeoutMs => new Promise(resolve => {
            if (seen) {
                resolve(true);
                return;
            }
            const timer = setTimeout(() => {
                this.responseListeners.delete(listener);
                resolve(false);
            }, timeoutMs);
            deliver = () => {
                clearTimeout(timer);
                resolve(true);
            };
        });
    }

    waitForStop(timeoutMs: number): Promise<WaitResult<S>> {
        const current = this.currentStop();
        if (current) {
            return Promise.resolve({ kind: 'stopped', ...current });
        }
        return this.arm()(timeoutMs);
    }

    readOutput({ since = 0, category, match, limit = DEFAULT_OUTPUT_LIMIT }: OutputQuery = {}): OutputPage {
        const needle = match?.toLowerCase();
        const matching = this.output.filter(e =>
            e.seq > since
            && (!category || e.category === category)
            && (!needle || e.text.toLowerCase().includes(needle)));

        const entries: OutputEntry[] = [];
        let budget = MAX_OUTPUT_CHARS;
        for (const entry of matching) {
            const text = truncate(entry.text, MAX_ENTRY_CHARS);
            if (entries.length >= limit || (entries.length > 0 && text.length > budget)) {
                break;
            }
            entries.push({ ...entry, text });
            budget -= text.length;
        }

        const more = entries.length < matching.length;
        const nextSince = more ? entries[entries.length - 1].seq : Math.max(since, this.outputSeq);
        return { entries, nextSince, more };
    }

    private onAdapterMessage(tracked: Tracked<S>, message: any) {
        if (message?.type === 'response') {
            this.onAdapterResponse(tracked, message);
        } else if (message?.type === 'event') {
            this.onAdapterEvent(tracked, message.event, message.body ?? {});
        }
    }

    private onAdapterResponse(tracked: Tracked<S>, message: any) {
        const command = tracked.pendingRequests.get(message.request_seq) ?? message.command;
        tracked.pendingRequests.delete(message.request_seq);
        if (command === 'initialize' && message.success) {
            tracked.capabilities = message.body ?? {};
        }
        [...this.responseListeners].forEach(listener => listener(command));
    }

    private onAdapterEvent(tracked: Tracked<S>, event: string, body: any) {
        switch (event) {
            case 'stopped':
                tracked.lastStop = { reason: body.reason, threadId: body.threadId, description: body.description, text: body.text };
                tracked.stoppedAt = ++this.stopCounter;
                this.notify({ kind: 'stopped', session: tracked.session, stop: tracked.lastStop });
                break;
            case 'continued':
                tracked.stoppedAt = 0;
                break;
            case 'output':
                this.appendOutput(tracked, body);
                break;
            case 'terminated':
            case 'exited':
                this.end(tracked);
                break;
        }
    }

    private appendOutput(tracked: Tracked<S>, body: any) {
        if (typeof body.output !== 'string' || body.category === 'telemetry') {
            return;
        }
        this.output.push({ seq: ++this.outputSeq, session: tracked.session.name, category: body.category ?? 'console', text: body.output });
        if (this.output.length > this.maxOutput) {
            this.output = this.output.slice(-this.maxOutput);
        }
    }

    private end(tracked: Tracked<S>) {
        if (tracked.ended) {
            return;
        }
        tracked.ended = true;
        tracked.stoppedAt = 0;
        this.sessions.delete(tracked.session.id);
        if (!this.hasLiveSession()) {
            this.notify({ kind: 'terminated' });
        }
    }

    private hasLiveSession(): boolean {
        return [...this.sessions.values()].some(t => !t.ended);
    }

    private notify(result: WaitResult<S>) {
        [...this.listeners].forEach(listener => listener(result));
    }
}

function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max)}… (${text.length - max} more characters)`;
}
