import * as vscode from 'vscode';
import { registerChatTools } from './tools/chat';
import { IPCServer } from './ipc/server';
import { registerIPCHandlers } from './ipc/handlers';
import { workspaceFolderPaths, setEventHub } from './tools/impl';
import * as path from 'path';
import { DebugEventHub } from './tools/impl/events';
import { LAUNCHER_NAME, blackboxHome, findNode, recordInstall } from './launcher/blackboxMcp';

export async function activate(context: vscode.ExtensionContext) {
    // Watch debug adapter traffic so tools can wait for stops and read output.
    const events = new DebugEventHub();
    setEventHub(events);
    context.subscriptions.push(events);

    // Register languageModelTools for # references in chat.
    registerChatTools(context);

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

    registerLauncher(context);

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

// Keeps ~/.blackbox/blackbox-mcp.js pointing at the newest installed server,
// so MCP configs don't need a version-specific path.
function registerLauncher(context: vscode.ExtensionContext) {
    const out = path.join(context.extensionPath, 'out');
    // A build run from source (F5) must not become the server MCP clients use.
    if (context.extensionMode !== vscode.ExtensionMode.Development) {
        try {
            recordInstall(
                { version: String(context.extension.packageJSON.version), server: path.join(out, 'mcp', 'server.js'), app: vscode.env.appName },
                path.join(out, 'launcher', 'blackboxMcp.js'),
            );
        } catch (err: unknown) {
            console.error('blackbox: could not update the MCP launcher:', err);
        }
    }

    context.subscriptions.push(vscode.commands.registerCommand('blackbox.copyMcpConfig', async () => {
        const config = { blackbox: { command: findNode(), args: [path.join(blackboxHome(), LAUNCHER_NAME)] } };
        await vscode.env.clipboard.writeText(JSON.stringify(config, null, 2));
        vscode.window.showInformationMessage('Blackbox MCP server configuration copied. Add it under "mcpServers" (or "servers" for VS Code mcp.json).');
    }));
}
