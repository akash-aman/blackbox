// Window-level state, used by the MCP bridge to tell windows apart.
// Called by the IPC status handler (ipc/handlers.ts).

import * as vscode from 'vscode';
import { WindowStatus } from '../../ipc/protocol';

export function workspaceFolderPaths(): string[] {
    return (vscode.workspace.workspaceFolders ?? [])
        .filter(f => f.uri.scheme === 'file')
        .map(f => f.uri.fsPath);
}

async function debugStatus(): Promise<WindowStatus['debug']> {
    const session = vscode.debug.activeDebugSession;
    if (!session) { return null; }

    const item = vscode.debug.activeStackItem;
    if (!(item instanceof vscode.DebugStackFrame) || item.session.id !== session.id) {
        return { name: session.name, type: session.type, state: 'running' };
    }

    let stoppedAt: { file: string; line: number } | undefined;
    try {
        const stack = await session.customRequest('stackTrace', { threadId: item.threadId, startFrame: 0, levels: 1 });
        const frame = stack.stackFrames?.[0];
        if (frame) {
            stoppedAt = { file: frame.source?.path || frame.source?.name || '(unknown)', line: frame.line };
        }
    } catch { /* adapter refused; state is still known */ }
    return { name: session.name, type: session.type, state: 'stopped', stoppedAt };
}

export async function getWindowStatus(): Promise<string> {
    const status: WindowStatus = {
        folders: workspaceFolderPaths(),
        focused: vscode.window.state.focused,
        breakpoints: vscode.debug.breakpoints.length,
        debug: await debugStatus(),
    };
    return JSON.stringify(status);
}
