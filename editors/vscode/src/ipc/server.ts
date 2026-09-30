// IPC server that runs INSIDE the VS Code extension host process.
// Listens on a per-window Unix socket for requests from the MCP stdio
// server, dispatches them to VS Code APIs, and returns results.
//
// The socket and registry file are named after this window's id (the
// extension host pid by default), so windows never touch each other's
// files. A periodic check recreates them if something else removes them.

import * as net from 'net';
import * as fs from 'fs';
import {
    AppInfo, IPCRequest, IPCResponse, PROTOCOL_VERSION, RegistryEntry, UNKNOWN_APP,
    assertPrivateDir, ipcDir, registryPath, socketPath,
} from './protocol';

type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

const HEALTH_CHECK_MS = 5000;
const isWindows = process.platform === 'win32';

export interface IPCServerOptions {
    id?: string;
    pid?: number; // Process that owns the window; defaults to this extension host.
    folders?: string[];
    healthCheckMs?: number;
    app?: AppInfo;
    appPid?: number;
    extensionVersion?: string;
}

// Creates the IPC directory, or tightens one this user already owns, then
// refuses to continue if another user could reach it.
function ensurePrivateDir(dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(dir);
    if (stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o077) !== 0) {
        fs.chmodSync(dir, 0o700);
    }
    assertPrivateDir(dir);
}

export class IPCServer {
    private server: net.Server | null = null;
    private handlers = new Map<string, ToolHandler>();
    private healthTimer: NodeJS.Timeout | null = null;
    private socketIno: number | null = null;
    private restarting = false;
    private disposed = false;
    private entry: RegistryEntry;
    private healthCheckMs: number;

    constructor(options: IPCServerOptions = {}) {
        this.healthCheckMs = options.healthCheckMs ?? HEALTH_CHECK_MS;
        const id = options.id ?? String(process.pid);
        const now = Date.now();
        this.entry = {
            id,
            pid: options.pid ?? process.pid,
            socket: socketPath(id),
            folders: options.folders ?? [],
            startedAt: now,
            focusedAt: now,
            app: options.app ?? UNKNOWN_APP,
            appPid: options.appPid ?? process.ppid,
            extensionVersion: options.extensionVersion ?? '',
            protocol: PROTOCOL_VERSION,
        };
    }

    get id(): string {
        return this.entry.id;
    }

    get socketPath(): string {
        return this.entry.socket;
    }

    register(name: string, handler: ToolHandler) {
        this.handlers.set(name, handler);
    }

    async start(): Promise<void> {
        if (isWindows) {
            fs.mkdirSync(ipcDir(), { recursive: true });
        } else {
            ensurePrivateDir(ipcDir());
        }
        await this.listen();
        this.writeRegistry();

        this.healthTimer = setInterval(() => this.checkHealth(), this.healthCheckMs);
        this.healthTimer.unref();
    }

    setFolders(folders: string[]) {
        this.entry.folders = folders;
        this.writeRegistry();
    }

    markFocused() {
        this.entry.focusedAt = Date.now();
        this.writeRegistry();
    }

    dispose() {
        this.disposed = true;
        if (this.healthTimer) {
            clearInterval(this.healthTimer);
        }
        this.server?.close();
        this.server = null;
        this.unlinkOwnSocket();
        try { fs.unlinkSync(registryPath(this.entry.id)); } catch { /* ignore */ }
    }

    private listen(): Promise<void> {
        // Our path is unique to this window, so anything there is a leftover
        // from a previous process that had the same pid.
        if (!isWindows) {
            try { fs.unlinkSync(this.entry.socket); } catch { /* ignore */ }
        }

        const server = net.createServer(socket => this.handleConnection(socket));
        return new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(this.entry.socket, () => {
                server.off('error', reject);
                server.on('error', err => console.error('blackbox IPC error:', err));
                this.server = server;
                this.socketIno = isWindows ? null : fs.statSync(this.entry.socket).ino;
                console.log(`blackbox IPC: listening on ${this.entry.socket}`);
                resolve();
            });
        });
    }

    private writeRegistry() {
        if (this.disposed) {
            return;
        }
        // Write then rename so readers never see a half-written file.
        const file = registryPath(this.entry.id);
        const tmp = `${file}.${process.pid}.tmp`;
        try {
            fs.writeFileSync(tmp, JSON.stringify(this.entry), { mode: 0o600 });
            fs.renameSync(tmp, file);
        } catch (err) {
            console.error('blackbox IPC: failed to write registry:', err);
        }
    }

    // Recreates the socket or registry file if they were removed or replaced.
    private async checkHealth() {
        if (this.disposed || this.restarting) {
            return;
        }
        if (!fs.existsSync(registryPath(this.entry.id))) {
            this.writeRegistry();
        }
        if (isWindows || this.ownsSocket()) {
            return;
        }

        console.warn(`blackbox IPC: ${this.entry.socket} went missing, restarting listener`);
        this.restarting = true;
        try {
            this.server?.close();
            this.server = null;
            await this.listen();
        } catch (err) {
            console.error('blackbox IPC: failed to restart listener:', err);
        } finally {
            this.restarting = false;
        }
    }

    private ownsSocket(): boolean {
        try {
            return fs.statSync(this.entry.socket).ino === this.socketIno;
        } catch {
            return false;
        }
    }

    private unlinkOwnSocket() {
        if (!isWindows && this.ownsSocket()) {
            try { fs.unlinkSync(this.entry.socket); } catch { /* ignore */ }
        }
    }

    private handleConnection(socket: net.Socket) {
        // The client may hang up (e.g. on timeout) before we reply.
        socket.on('error', () => { /* ignore */ });

        let buffer = '';
        socket.on('data', chunk => {
            buffer += chunk.toString();
            let nl: number;
            while ((nl = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                this.handleMessage(line, socket);
            }
        });
    }

    private async handleMessage(line: string, socket: net.Socket) {
        let req: IPCRequest;
        try {
            req = JSON.parse(line);
        } catch {
            return;
        }

        const handler = this.handlers.get(req.tool);
        let resp: IPCResponse;
        if (!handler) {
            resp = { id: req.id, error: `unknown tool: ${req.tool}` };
        } else {
            try {
                resp = { id: req.id, result: await handler(req.args) };
            } catch (err: unknown) {
                resp = { id: req.id, error: err instanceof Error ? err.message : String(err) };
            }
        }

        if (!socket.destroyed && socket.writable) {
            socket.write(JSON.stringify(resp) + '\n');
        }
    }
}
