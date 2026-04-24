// IPC server that runs INSIDE the VS Code extension host process.
// Listens on a Unix socket for requests from the MCP stdio server,
// dispatches them to VS Code APIs, and returns results.

import * as net from 'net';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { IPCRequest, IPCResponse, IPC_SOCKET_PATH } from './protocol';

type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

export class IPCServer {
    private server: net.Server | null = null;
    private handlers = new Map<string, ToolHandler>();

    register(name: string, handler: ToolHandler) {
        this.handlers.set(name, handler);
    }

    start(context: vscode.ExtensionContext) {
        // Remove stale socket file.
        try { fs.unlinkSync(IPC_SOCKET_PATH); } catch { /* ignore */ }

        this.server = net.createServer(socket => {
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
        });

        this.server.listen(IPC_SOCKET_PATH, () => {
            console.log(`blackbox IPC: listening on ${IPC_SOCKET_PATH}`);
        });

        this.server.on('error', err => {
            console.error('blackbox IPC error:', err);
        });

        context.subscriptions.push({
            dispose: () => {
                this.server?.close();
                try { fs.unlinkSync(IPC_SOCKET_PATH); } catch { /* ignore */ }
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
        if (!handler) {
            const resp: IPCResponse = { id: req.id, error: `unknown tool: ${req.tool}` };
            socket.write(JSON.stringify(resp) + '\n');
            return;
        }

        try {
            const result = await handler(req.args);
            const resp: IPCResponse = { id: req.id, result };
            socket.write(JSON.stringify(resp) + '\n');
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            const resp: IPCResponse = { id: req.id, error: msg };
            socket.write(JSON.stringify(resp) + '\n');
        }
    }
}
