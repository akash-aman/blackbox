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

interface PendingRequest { readonly command: string; readonly threadId?: number }
interface Pause { readonly stop: StopEvent; readonly order: number } // Order across all sessions.

interface Tracked<S> {
    readonly session: S;
    readonly pendingRequests: Map<number, PendingRequest>; // By request seq.
    // Threads paused right now. Some adapters (Xdebug) pause each thread
    // (request) independently, so a session can have several.
    readonly paused: Map<number, Pause>;
    capabilities: Record<string, unknown>;
    lastStop?: StopEvent;
    ended: boolean;
}

// Key for a stopped event that names no thread.
const NO_THREAD = -1;

type Listener<S> = (result: WaitResult<S>) => void;
// command is undefined when the session ended.
type ResponseListener = (command: string | undefined, sessionId: string) => void;

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
    private trackCount = 0;

    constructor(private readonly maxOutput = 1000) {}

    // Debug adapters created so far; a start that never raises this is stuck
    // before the adapter exists (e.g. on a prompt in the editor).
    get adaptersCreated(): number {
        return this.trackCount;
    }

    track(session: S): TrackerHandlers {
        this.trackCount++;
        const tracked: Tracked<S> = { session, pendingRequests: new Map(), paused: new Map(), capabilities: {}, ended: false };
        this.sessions.set(session.id, tracked);
        return {
            onDidSendMessage: message => this.onAdapterMessage(tracked, message),
            onWillReceiveMessage: message => {
                if (message?.type !== 'request') {
                    return;
                }
                const threadId: number | undefined = message.arguments?.threadId;
                tracked.pendingRequests.set(message.seq, { command: message.command, threadId });
                if (RESUMING_REQUESTS.has(message.command)) {
                    this.resume(tracked, threadId);
                }
            },
            onWillStopSession: () => this.end(tracked),
            onExit: () => this.end(tracked),
        };
    }

    capabilities(sessionId: string): Record<string, unknown> {
        return this.sessions.get(sessionId)?.capabilities ?? {};
    }

    // The most recent pause still in effect in this session, else the last one seen.
    lastStop(sessionId: string): StopEvent | undefined {
        const tracked = this.sessions.get(sessionId);
        return tracked && (latestPause(tracked)?.stop ?? tracked.lastStop);
    }

    isPaused(sessionId: string): boolean {
        const tracked = this.sessions.get(sessionId);
        return !!tracked && !tracked.ended && tracked.paused.size > 0;
    }

    pausedThreads(sessionId: string): number[] {
        return [...(this.sessions.get(sessionId)?.paused.keys() ?? [])].filter(id => id !== NO_THREAD);
    }

    // The most recent pause still in effect, across sessions.
    currentStop(): { session: S; stop: StopEvent } | undefined {
        let latest: { session: S; pause: Pause } | undefined;
        for (const tracked of this.sessions.values()) {
            const pause = latestPause(tracked);
            if (pause && (!latest || pause.order > latest.pause.order)) {
                latest = { session: tracked.session, pause };
            }
        }
        return latest && { session: latest.session, stop: latest.pause.stop };
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

    // Starts listening for responses to the next `command` request (e.g.
    // setBreakpoints) from every session live now. The returned function
    // resolves true once each of them has answered or ended, false on
    // timeout, and at once with false if no session is live. Waiting for all
    // matters: js-debug has a parent and a child session, and only the child
    // runs the program.
    armResponse(command: string): (timeoutMs: number) => Promise<boolean> {
        const waiting = new Set([...this.sessions.values()].filter(t => !t.ended).map(t => t.session.id));
        if (waiting.size === 0) {
            return async () => false;
        }
        let deliver: (() => void) | undefined;
        const listener: ResponseListener = (responded, sessionId) => {
            if (responded === command || responded === undefined) {
                waiting.delete(sessionId);
            }
            if (waiting.size === 0) {
                this.responseListeners.delete(listener);
                deliver?.();
            }
        };
        this.responseListeners.add(listener);

        return timeoutMs => new Promise(resolve => {
            if (waiting.size === 0) {
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

    // Returns the current pause at once, unless `next` asks for a new one
    // (e.g. another request pausing while one is already paused).
    waitForStop(timeoutMs: number, { next = false } = {}): Promise<WaitResult<S>> {
        const current = next ? undefined : this.currentStop();
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
        const request = tracked.pendingRequests.get(message.request_seq);
        const command = request?.command ?? message.command;
        tracked.pendingRequests.delete(message.request_seq);
        if (command === 'initialize' && message.success) {
            tracked.capabilities = message.body ?? {};
        }
        // DAP: a continue resumes every thread unless the response says otherwise.
        if (command === 'continue' && message.success && message.body?.allThreadsContinued !== false) {
            tracked.paused.clear();
        }
        [...this.responseListeners].forEach(listener => listener(command, tracked.session.id));
    }

    private onAdapterEvent(tracked: Tracked<S>, event: string, body: any) {
        switch (event) {
            case 'stopped':
                tracked.lastStop = { reason: body.reason, threadId: body.threadId, description: body.description, text: body.text };
                tracked.paused.set(body.threadId ?? NO_THREAD, { stop: tracked.lastStop, order: ++this.stopCounter });
                this.notify({ kind: 'stopped', session: tracked.session, stop: tracked.lastStop });
                break;
            case 'continued':
                this.resume(tracked, body.allThreadsContinued ? undefined : body.threadId);
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

    // Marks one thread, or with no thread id all threads, as running.
    private resume(tracked: Tracked<S>, threadId: number | undefined) {
        if (threadId === undefined) {
            tracked.paused.clear();
        } else {
            tracked.paused.delete(threadId);
            tracked.paused.delete(NO_THREAD);
        }
    }

    private end(tracked: Tracked<S>) {
        if (tracked.ended) {
            return;
        }
        tracked.ended = true;
        tracked.paused.clear();
        this.sessions.delete(tracked.session.id);
        [...this.responseListeners].forEach(listener => listener(undefined, tracked.session.id));
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

function latestPause(tracked: Tracked<unknown>): Pause | undefined {
    let latest: Pause | undefined;
    for (const pause of tracked.paused.values()) {
        if (!latest || pause.order > latest.order) { latest = pause; }
    }
    return latest;
}
