// Core workspace tool implementations.
// Called by both languageModelTools (tools/workspace.ts) and IPC handlers (ipc/handlers.ts).

import * as vscode from 'vscode';

export async function findFile(args: { pattern: string; maxResults?: number }): Promise<string> {
    const { pattern, maxResults } = args;
    if (!pattern) { return 'Error: glob pattern is required'; }
    const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', maxResults || 20);
    return JSON.stringify(files.map(f => f.fsPath), null, 2);
}

export async function getDiagnostics(args: { file?: string; severity?: string }): Promise<string> {
    const { file, severity } = args;
    let diagnostics: [vscode.Uri, vscode.Diagnostic[]][];
    if (file) {
        const uri = vscode.Uri.file(file);
        diagnostics = [[uri, vscode.languages.getDiagnostics(uri)]];
    } else {
        diagnostics = vscode.languages.getDiagnostics();
    }
    const minSev = severity === 'error' ? 0 : severity === 'warning' ? 1 : undefined;
    const result = diagnostics
        .filter(([, diags]) => diags.length > 0)
        .map(([uri, diags]) => ({
            file: uri.fsPath,
            issues: diags
                .filter(d => minSev === undefined || d.severity <= minSev)
                .map(d => ({ line: d.range.start.line + 1, severity: d.severity === 0 ? 'error' : d.severity === 1 ? 'warning' : 'info', message: d.message, source: d.source || undefined })),
        }))
        .filter(e => e.issues.length > 0);
    return result.length ? JSON.stringify(result, null, 2) : 'No diagnostics found';
}
