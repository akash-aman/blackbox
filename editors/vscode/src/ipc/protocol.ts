// IPC protocol between the MCP stdio server (child process) and the
// VS Code extension host. Communication is over a Unix socket using
// newline-delimited JSON.

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

export const IPC_SOCKET_PATH = '/tmp/blackbox-debug.sock';
