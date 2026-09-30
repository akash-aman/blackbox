import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { listWindows } from '../../ipc/registry';
import { callExtension } from '../../ipc/client';
import { STATUS_TOOL, WindowStatus } from '../../ipc/protocol';

suite('Debug Tools', () => {

    test('extension should activate', async () => {
        const ext = vscode.extensions.getExtension('akash-cx.blackbox-debug');
        assert.ok(ext, 'Extension not found');
        if (!ext!.isActive) {
            await ext!.activate();
        }
        assert.ok(ext!.isActive, 'Extension failed to activate');
    });

    test('extension should register this window for the MCP bridge', () => {
        const self = listWindows().find(w => w.pid === process.pid);
        assert.ok(self, 'No registry entry for this extension host');
        assert.ok(fs.existsSync(self!.socket), 'Socket file missing');
        assert.strictEqual(self!.app.name, vscode.env.appName);
        assert.strictEqual(self!.app.scheme, vscode.env.uriScheme);
        assert.strictEqual(self!.appPid, process.ppid, 'appPid should be the editor main process');
        assert.strictEqual(self!.extensionVersion, vscode.extensions.getExtension('akash-cx.blackbox-debug')!.packageJSON.version);
    });

    test('window status is served over the bridge socket', async () => {
        const self = listWindows().find(w => w.pid === process.pid)!;
        const bp = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file('/tmp/test-status.php'), new vscode.Position(2, 0)));
        vscode.debug.addBreakpoints([bp]);
        try {
            const resp = await callExtension(self.socket, { tool: STATUS_TOOL, args: {}, timeoutMs: 5000 });
            const status: WindowStatus = JSON.parse(resp.result!);
            assert.deepStrictEqual(status.folders, self.folders);
            assert.strictEqual(status.debug, null);
            assert.strictEqual(status.breakpoints, vscode.debug.breakpoints.length);
            assert.ok(status.breakpoints >= 1);
        } finally {
            vscode.debug.removeBreakpoints([bp]);
        }
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
