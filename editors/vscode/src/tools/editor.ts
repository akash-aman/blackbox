// Thin wrappers that register languageModelTools for # references in chat.
// All logic lives in ./impl/editor.ts.

import * as vscode from 'vscode';
import * as impl from './impl/editor';

const i = (o: { input: unknown }) => (o.input ?? {}) as Record<string, any>;
const txt = (text: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);

export function registerEditorTools(context: vscode.ExtensionContext) {

    context.subscriptions.push(vscode.lm.registerTool('editor_open_file', {
        prepareInvocation(options, _token) { const inp = i(options); return { invocationMessage: `Opening ${inp.file}${inp.line ? ':' + inp.line : ''}` }; },
        async invoke(options, _token) { return txt(await impl.openFile(options.input as any)); },
    }));

    context.subscriptions.push(vscode.lm.registerTool('editor_get_open_files', {
        prepareInvocation(_options, _token) { return { invocationMessage: 'Getting open files' }; },
        async invoke(_options, _token) { return txt(await impl.getOpenFiles()); },
    }));
}
