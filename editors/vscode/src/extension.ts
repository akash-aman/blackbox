import * as vscode from 'vscode';
import { registerAllTools } from './tools';
import { IPCServer } from './ipc/server';
import { registerIPCHandlers } from './ipc/handlers';
import { workspaceFolderPaths, setEventHub } from './tools/impl';
import { DebugEventHub } from './tools/impl/events';

export async function activate(context: vscode.ExtensionContext) {
    // Watch debug adapter traffic so tools can wait for stops and read output.
    const events = new DebugEventHub();
    setEventHub(events);
    context.subscriptions.push(events);

    // Register languageModelTools for # references in chat.
    registerAllTools(context);

    // Start this window's IPC server for the MCP stdio bridge.
    const ipc = new IPCServer({
        folders: workspaceFolderPaths(),
        app: { name: vscode.env.appName, scheme: vscode.env.uriScheme, version: vscode.version },
        appPid: process.ppid,
        extensionVersion: String(context.extension.packageJSON.version),
    });
    registerIPCHandlers(ipc);
    context.subscriptions.push(
        ipc,
        vscode.workspace.onDidChangeWorkspaceFolders(() => ipc.setFolders(workspaceFolderPaths())),
        vscode.window.onDidChangeWindowState(state => { if (state.focused) { ipc.markFocused(); } }),
    );

    // AI tools started in this window's terminals inherit it and use this window.
    const terminalEnv = context.environmentVariableCollection;
    terminalEnv.persistent = false;
    terminalEnv.description = 'Lets AI tools started here use this window through Blackbox';
    terminalEnv.replace('BLACKBOX_WINDOW', ipc.id);

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
