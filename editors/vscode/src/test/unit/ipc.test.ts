// Node-only tests for the MCP <-> extension host bridge. No VS Code needed:
// each IPCServer here stands in for one VS Code window.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { IPCServer } from '../../ipc/server';
import { callExtension } from '../../ipc/client';
import { listWindows, pickWindow } from '../../ipc/registry';
import { RegistryEntry } from '../../ipc/protocol';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function tmpDir(prefix: string): string {
    // Keep socket paths short: macOS limits them to 104 bytes.
    return fs.realpathSync(fs.mkdtempSync(path.join('/tmp', prefix)));
}

function fakeWindow(id: string, folder: string, opts: { healthCheckMs?: number } = {}): IPCServer {
    const ipc = new IPCServer({ id, folders: [folder], healthCheckMs: opts.healthCheckMs });
    ipc.register('whoami', async () => id);
    ipc.register('slow', async () => { await sleep(300); return 'late'; });
    ipc.register('boom', async () => { throw new Error('kaboom'); });
    return ipc;
}

suite('IPC bridge', () => {
    let ipcDir: string;
    let wsA: string;
    let wsB: string;
    let windows: IPCServer[];

    setup(() => {
        ipcDir = tmpDir('bbx-ipc-');
        process.env.BLACKBOX_IPC_DIR = ipcDir;
        wsA = tmpDir('bbx-wsA-');
        wsB = tmpDir('bbx-wsB-');
        windows = [];
    });

    teardown(() => {
        windows.forEach(w => w.dispose());
        delete process.env.BLACKBOX_IPC_DIR;
        for (const d of [ipcDir, wsA, wsB]) {
            fs.rmSync(d, { recursive: true, force: true });
        }
    });

    async function open(id: string, folder: string, opts?: { healthCheckMs?: number }) {
        const w = fakeWindow(id, folder, opts);
        await w.start();
        windows.push(w);
        return w;
    }

    const who = (cwd: string) => callExtension('whoami', {}, { timeoutMs: 2000, cwd }).then(r => r.result);

    test('routes each call to the window that owns the cwd', async () => {
        await open('A', wsA);
        await open('B', wsB);
        assert.strictEqual(await who(wsA), 'A');
        assert.strictEqual(await who(path.join(wsB, 'src', 'deep')), 'B');
    });

    test('closing one window does not break another (regression)', async () => {
        const a = await open('A', wsA);
        const b = await open('B', wsB);
        b.dispose();
        assert.ok(fs.existsSync(a.socketPath), 'window A socket must survive window B closing');
        assert.strictEqual(await who(wsA), 'A');
        // A call from B's folder falls back to the remaining window.
        assert.strictEqual(await who(wsB), 'A');
    });

    test('reloading a window is picked up without reconnecting', async () => {
        const first = await open('A', wsA);
        assert.strictEqual(await who(wsA), 'A');
        first.dispose();
        await open('A2', wsA);
        assert.strictEqual(await who(wsA), 'A2');
    });

    test('recreates its socket if the file is deleted', async () => {
        const a = await open('A', wsA, { healthCheckMs: 50 });
        fs.unlinkSync(a.socketPath);
        await sleep(200);
        assert.ok(fs.existsSync(a.socketPath), 'socket should be recreated');
        assert.strictEqual(await who(wsA), 'A');
    });

    test('retries while the window is still starting', async () => {
        const pending = who(wsA);
        await sleep(100);
        await open('A', wsA);
        assert.strictEqual(await pending, 'A');
    });

    test('survives a client that hangs up before the reply', async () => {
        await open('A', wsA);
        await assert.rejects(
            callExtension('slow', {}, { timeoutMs: 50, cwd: wsA }),
            (err: any) => err.code === 'ETIMEDOUT',
        );
        await sleep(400); // Let the handler finish and try to write.
        assert.strictEqual(await who(wsA), 'A');
    });

    test('returns handler errors as errors', async () => {
        await open('A', wsA);
        const resp = await callExtension('boom', {}, { timeoutMs: 2000, cwd: wsA });
        assert.strictEqual(resp.error, 'kaboom');
    });

    test('removes registry entries of dead extension hosts', async () => {
        const stale: RegistryEntry = {
            id: 'dead', pid: 2 ** 22 + 1, socket: path.join(ipcDir, 'dead.sock'),
            folders: [wsA], startedAt: 0, focusedAt: 0,
        };
        fs.writeFileSync(path.join(ipcDir, 'dead.json'), JSON.stringify(stale));
        await open('B', wsB);
        assert.deepStrictEqual(listWindows().map(w => w.id), ['B']);
        assert.ok(!fs.existsSync(path.join(ipcDir, 'dead.json')));
    });

    test('end to end through the MCP stdio server', async function () {
        this.timeout(15000);
        await open('A', wsA);
        const b = await open('B', wsB);
        b.register('debug_list_breakpoints', async () => 'breakpoints from B');

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [path.resolve(__dirname, '../../mcp/server.js')],
            cwd: wsB,
            env: { ...process.env, BLACKBOX_IPC_DIR: ipcDir } as Record<string, string>,
        });
        const client = new Client({ name: 'test', version: '0.0.0' });
        await client.connect(transport);
        try {
            const ok: any = await client.callTool({ name: 'debug_list_breakpoints', arguments: {} });
            assert.strictEqual(ok.content[0].text, 'breakpoints from B');
            assert.ok(!ok.isError);

            // Window A has no such handler: the error must be flagged.
            windows.forEach(w => w.dispose());
            windows = [];
            await open('A', wsA);
            const bad: any = await client.callTool({ name: 'debug_list_breakpoints', arguments: {} });
            assert.strictEqual(bad.isError, true);
            assert.match(bad.content[0].text, /unknown tool/);
        } finally {
            await client.close();
        }
    });
});

suite('pickWindow', () => {
    const entry = (id: string, folders: string[], focusedAt = 0): RegistryEntry =>
        ({ id, pid: process.pid, socket: `/x/${id}`, folders, startedAt: 0, focusedAt });

    test('prefers the deepest containing folder', () => {
        const picked = pickWindow([entry('outer', ['/proj']), entry('inner', ['/proj/app'])], '/proj/app/src');
        assert.strictEqual(picked?.id, 'inner');
    });

    test('does not match sibling folders sharing a prefix', () => {
        const picked = pickWindow([entry('a', ['/proj-a'], 1), entry('b', ['/proj'], 0)], '/proj-a2');
        assert.strictEqual(picked?.id, 'a', 'falls back to most recently focused');
    });

    test('matches a window opened on a subfolder of cwd', () => {
        const picked = pickWindow([entry('other', ['/elsewhere'], 9), entry('sub', ['/proj/app'])], '/proj');
        assert.strictEqual(picked?.id, 'sub');
    });

    test('falls back to the most recently focused window', () => {
        const picked = pickWindow([entry('old', ['/a'], 1), entry('new', ['/b'], 2)], '/c');
        assert.strictEqual(picked?.id, 'new');
    });

    test('returns undefined with no windows', () => {
        assert.strictEqual(pickWindow([], '/c'), undefined);
    });
});
