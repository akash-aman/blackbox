import * as vscode from 'vscode';
import { registerAllTools } from './tools';
import { IPCServer } from './ipc/server';
import { registerIPCHandlers } from './ipc/handlers';

export function activate(context: vscode.ExtensionContext) {
    // Register languageModelTools for # references in chat.
    registerAllTools(context);

    // Start IPC server for the MCP stdio bridge.
    const ipc = new IPCServer();
    registerIPCHandlers(ipc);
    ipc.start(context);

    console.log('blackbox: activated — LM tools + IPC server registered');
}

export function deactivate() {
    // IPC server cleanup handled via context.subscriptions
}
