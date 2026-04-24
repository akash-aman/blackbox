// Core editor tool implementations.
// Called by both languageModelTools (tools/editor.ts) and IPC handlers (ipc/handlers.ts).

import * as vscode from 'vscode';

export async function openFile(args: { file: string; line?: number }): Promise<string> {
    const { file, line } = args;
    if (!file) { return 'Error: file path is required'; }
    const uri = vscode.Uri.file(file);
    try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const opts: vscode.TextDocumentShowOptions = {};
        if (line && line > 0) {
            const pos = new vscode.Position(line - 1, 0);
            opts.selection = new vscode.Range(pos, pos);
        }
        await vscode.window.showTextDocument(doc, opts);
        return 'Opened ' + file + (line ? ':' + line : '');
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return 'Error opening file: ' + msg;
    }
}

export async function getOpenFiles(): Promise<string> {
    const tabs = vscode.window.tabGroups.all.flatMap(group =>
        group.tabs.map(tab => {
            const input = tab.input;
            if (input instanceof vscode.TabInputText) {
                return { file: input.uri.fsPath, active: tab.isActive, dirty: tab.isDirty };
            }
            return null;
        }).filter(Boolean)
    );
    return JSON.stringify(tabs, null, 2);
}
