// Thin wrappers that register languageModelTools for # references in chat.
// All logic lives in ./impl/workspace.ts.

import * as vscode from 'vscode';
import * as impl from './impl/workspace';

const i = (o: { input: unknown }) => (o.input ?? {}) as Record<string, any>;
const txt = (text: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);

export function registerWorkspaceTools(context: vscode.ExtensionContext) {

    context.subscriptions.push(vscode.lm.registerTool('workspace_find_file', {
        prepareInvocation(options, _token) { return { invocationMessage: `Finding files: ${i(options).pattern}` }; },
        async invoke(options, _token) { return txt(await impl.findFile(options.input as any)); },
    }));

    context.subscriptions.push(vscode.lm.registerTool('workspace_get_diagnostics', {
        prepareInvocation(options, _token) { return { invocationMessage: `Getting diagnostics${i(options).file ? ' for ' + i(options).file : ''}` }; },
        async invoke(options, _token) { return txt(await impl.getDiagnostics(options.input as any)); },
    }));
}
