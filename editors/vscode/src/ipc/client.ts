// IPC client used by the MCP stdio server. Resolves the target window on
// every call, so windows can reload or restart without reconnecting MCP.

import * as net from 'net';
import { IPCRequest, IPCResponse } from './protocol';
import { listWindows, pickWindow } from './registry';

const RETRY_DELAYS_MS = [250, 500, 750];
// Only errors where the request never reached VS Code, so a retry cannot
// run a tool (e.g. a step) twice.
const RETRYABLE = new Set(['ENOENT', 'ECONNREFUSED']);

let requestId = 0;

export class IPCError extends Error {
    constructor(message: string, readonly code?: string) {
        super(message);
    }
}

export interface CallOptions {
    timeoutMs: number;
    cwd?: string;
}

// BLACKBOX_SOCKET pins a socket; BLACKBOX_WORKSPACE overrides the directory
// used to pick a window (defaults to the MCP server's cwd).
function resolveSocket(cwd: string): string {
    if (process.env.BLACKBOX_SOCKET) {
        return process.env.BLACKBOX_SOCKET;
    }
    const window = pickWindow(listWindows(), cwd);
    if (!window) {
        throw new IPCError('No VS Code window with the Blackbox extension is running.', 'ENOENT');
    }
    return window.socket;
}

function send(socket: string, req: IPCRequest, timeoutMs: number): Promise<IPCResponse> {
    return new Promise((resolve, reject) => {
        const client = net.createConnection(socket, () => {
            client.write(JSON.stringify(req) + '\n');
        });
        const timer = setTimeout(() => {
            client.destroy();
            reject(new IPCError(`VS Code did not answer ${req.tool} within ${timeoutMs / 1000}s.`, 'ETIMEDOUT'));
        }, timeoutMs);

        let buffer = '';
        client.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const nl = buffer.indexOf('\n');
            if (nl < 0) {
                return;
            }
            clearTimeout(timer);
            client.end();
            try {
                resolve(JSON.parse(buffer.slice(0, nl)));
            } catch {
                reject(new IPCError('Malformed response from VS Code.'));
            }
        });
        client.on('error', (err: NodeJS.ErrnoException) => {
            clearTimeout(timer);
            reject(new IPCError(err.message, err.code));
        });
    });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function callExtension(tool: string, args: Record<string, unknown>, options: CallOptions): Promise<IPCResponse> {
    const cwd = options.cwd ?? process.env.BLACKBOX_WORKSPACE ?? process.cwd();
    const req: IPCRequest = { id: String(++requestId), tool, args };

    for (let attempt = 0; ; attempt++) {
        try {
            // Re-resolve each attempt: a restarted window gets a new socket.
            return await send(resolveSocket(cwd), req, options.timeoutMs);
        } catch (err: unknown) {
            const code = err instanceof IPCError ? err.code : undefined;
            if (attempt >= RETRY_DELAYS_MS.length || !code || !RETRYABLE.has(code)) {
                throw err;
            }
            await sleep(RETRY_DELAYS_MS[attempt]);
        }
    }
}
