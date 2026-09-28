// IPC protocol between the MCP stdio server (child process) and the
// VS Code extension host. Communication is over a Unix socket using
// newline-delimited JSON.
//
// Every VS Code window runs its own extension host, so each one listens on
// its own socket and advertises itself with a registry file next to it:
//
//   <ipcDir>/<id>.sock   the socket
//   <ipcDir>/<id>.json   RegistryEntry describing the window
//
// The MCP server reads the registry to pick the window that owns its
// working directory (see registry.ts).

import * as path from 'path';
import * as os from 'os';

export interface IPCRequest {
    id: string;
    tool: string;
    args: Record<string, unknown>;
}

export interface IPCResponse {
    id: string;
    result?: string;
    error?: string;
}

export interface RegistryEntry {
    id: string;
    pid: number;
    socket: string;
    folders: string[];
    startedAt: number;
    focusedAt: number;
}

// A fixed directory rather than os.tmpdir(): the extension host and the MCP
// server are started by different parents and often see different TMPDIRs.
export function ipcDir(): string {
    if (process.env.BLACKBOX_IPC_DIR) {
        return process.env.BLACKBOX_IPC_DIR;
    }
    return process.platform === 'win32' ? path.join(os.tmpdir(), 'blackbox') : '/tmp/blackbox';
}

export function socketPath(id: string): string {
    if (process.platform === 'win32') {
        return `\\\\.\\pipe\\blackbox-${id}`;
    }
    return path.join(ipcDir(), `${id}.sock`);
}

export function registryPath(id: string): string {
    return path.join(ipcDir(), `${id}.json`);
}
