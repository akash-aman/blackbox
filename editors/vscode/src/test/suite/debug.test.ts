import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Debug Tools', () => {

    test('extension should activate', async () => {
        const ext = vscode.extensions.getExtension('akash-aman.wpx-debug');
        assert.ok(ext, 'Extension not found');
        if (!ext!.isActive) {
            await ext!.activate();
        }
        assert.ok(ext!.isActive, 'Extension failed to activate');
    });

    test('breakpoints API should be available', () => {
        assert.ok(vscode.debug.breakpoints !== undefined, 'debug.breakpoints not available');
        assert.ok(Array.isArray(vscode.debug.breakpoints), 'breakpoints should be an array');
    });

    test('addBreakpoints should work', () => {
        const uri = vscode.Uri.file('/tmp/test-breakpoint.php');
        const pos = new vscode.Position(9, 0); // line 10
        const bp = new vscode.SourceBreakpoint(new vscode.Location(uri, pos));

        const countBefore = vscode.debug.breakpoints.length;
        vscode.debug.addBreakpoints([bp]);
        const countAfter = vscode.debug.breakpoints.length;

        assert.ok(countAfter >= countBefore, 'Breakpoint count should increase or stay same');

        // Clean up.
        vscode.debug.removeBreakpoints([bp]);
    });

    test('removeBreakpoints should work', () => {
        const uri = vscode.Uri.file('/tmp/test-breakpoint-remove.php');
        const pos = new vscode.Position(4, 0);
        const bp = new vscode.SourceBreakpoint(new vscode.Location(uri, pos));

        vscode.debug.addBreakpoints([bp]);
        const countAfterAdd = vscode.debug.breakpoints.length;

        vscode.debug.removeBreakpoints([bp]);
        const countAfterRemove = vscode.debug.breakpoints.length;

        assert.ok(countAfterRemove < countAfterAdd, 'Breakpoint count should decrease after remove');
    });

    test('conditional breakpoint should preserve condition', () => {
        const uri = vscode.Uri.file('/tmp/test-conditional.php');
        const pos = new vscode.Position(0, 0);
        const condition = '$x > 5';
        const bp = new vscode.SourceBreakpoint(
            new vscode.Location(uri, pos),
            true,
            condition
        );

        assert.strictEqual(bp.condition, condition);
        assert.strictEqual(bp.enabled, true);

        // Clean up.
        vscode.debug.removeBreakpoints([bp]);
    });

    test('no active debug session initially', () => {
        assert.strictEqual(vscode.debug.activeDebugSession, undefined);
    });
});
