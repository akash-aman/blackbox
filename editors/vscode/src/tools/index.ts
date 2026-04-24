import * as vscode from 'vscode';
import { registerDebugTools } from './debug';
import { registerEditorTools } from './editor';
import { registerWorkspaceTools } from './workspace';

export function registerAllTools(context: vscode.ExtensionContext) {
    registerDebugTools(context);
    registerEditorTools(context);
    registerWorkspaceTools(context);
}
