import * as vscode from 'vscode';
import { registerAllTools } from './tools';
import { IPCServer } from './ipc/server';
import { registerIPCHandlers } from './ipc/handlers';

function workspaceFolders(): string[] {
    return (vscode.workspace.workspaceFolders ?? [])
        .filter(f => f.uri.scheme === 'file')
        .map(f => f.uri.fsPath);
}

export async function activate(context: vscode.ExtensionContext) {
    // Register languageModelTools for # references in chat.
    registerAllTools(context);

    // Start this window's IPC server for the MCP stdio bridge.
    const ipc = new IPCServer({ folders: workspaceFolders() });
    registerIPCHandlers(ipc);
    context.subscriptions.push(
        ipc,
        vscode.workspace.onDidChangeWorkspaceFolders(() => ipc.setFolders(workspaceFolders())),
        vscode.window.onDidChangeWindowState(state => { if (state.focused) { ipc.markFocused(); } }),
    );

    try {
        await ipc.start();
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Blackbox: could not start the MCP bridge (${msg}).`);
        return;
    }

    console.log(`blackbox: activated — LM tools + IPC server on ${ipc.socketPath}`);
}

export function deactivate() {
    // IPC server cleanup handled via context.subscriptions
}
