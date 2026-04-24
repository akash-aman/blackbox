import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Editor Tools', () => {

    test('openTextDocument should work with URI', async () => {
        // Create a temp untitled document.
        const doc = await vscode.workspace.openTextDocument({
            content: '<?php\necho "hello";\n',
            language: 'php',
        });
        assert.ok(doc, 'Document should be created');
        assert.strictEqual(doc.languageId, 'php');
        assert.ok(doc.getText().includes('echo "hello"'));
    });

    test('showTextDocument should open editor', async () => {
        const doc = await vscode.workspace.openTextDocument({
            content: 'test content',
            language: 'plaintext',
        });
        const editor = await vscode.window.showTextDocument(doc);
        assert.ok(editor, 'Editor should be created');
        assert.strictEqual(editor.document.getText(), 'test content');
    });

    test('tabGroups should be accessible', () => {
        assert.ok(vscode.window.tabGroups, 'tabGroups should be available');
        assert.ok(Array.isArray(vscode.window.tabGroups.all), 'tabGroups.all should be array');
    });
});

suite('Workspace Tools', () => {

    test('findFiles should return results', async () => {
        const files = await vscode.workspace.findFiles('**/*.json', '**/node_modules/**', 5);
        // May return 0 in test environment, but should not throw.
        assert.ok(Array.isArray(files), 'findFiles should return array');
    });

    test('getDiagnostics should work', () => {
        const diagnostics = vscode.languages.getDiagnostics();
        assert.ok(Array.isArray(diagnostics), 'getDiagnostics should return array');
    });
});
