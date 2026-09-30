// The version-independent MCP launcher (~/.blackbox/blackbox-mcp.js).

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InstallRecord, LAUNCHER_NAME, compareVersions, findNode, launcherStamp, pickServer, readInstalls, readStamp, recordInstall, shouldReplaceLauncher } from '../../launcher/blackboxMcp';

const OUT = path.resolve(__dirname, '../..');
const SERVER = path.join(OUT, 'mcp/server.js');
const LAUNCHER_SOURCE = path.join(OUT, 'launcher/blackboxMcp.js');

const record = (version: string, server: string, recordedAt = 0): InstallRecord => ({ version, server, app: 'Test', recordedAt });

suite('MCP launcher', () => {
    let home: string;

    setup(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'bbx-home-')); });
    teardown(() => { fs.rmSync(home, { recursive: true, force: true }); });

    test('compares versions numerically, pre-releases before releases', () => {
        assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
        assert.ok(compareVersions('1.0.0', '1.0.0-beta') > 0);
        assert.ok(compareVersions('0.4.1', '0.4.1') === 0);
        assert.ok(compareVersions('0.4', '0.4.1') < 0);
    });

    test('picks the newest install that still exists', () => {
        const exists = (f: string) => f !== '/gone/server.js';
        const records = [record('0.3.0', '/a/server.js'), record('0.9.0', '/gone/server.js'), record('0.4.1', '/b/server.js')];
        assert.strictEqual(pickServer(records, exists)?.server, '/b/server.js');
        assert.strictEqual(pickServer([], exists), undefined);
    });

    test('prefers the most recently recorded of equal versions', () => {
        const records = [record('0.4.1', '/vscode/server.js', 1), record('0.4.1', '/antigravity/server.js', 2)];
        assert.strictEqual(pickServer(records, () => true)?.server, '/antigravity/server.js');
    });

    // Two installs of the "extension": real files, different versions.
    function fakeInstall(name: string): string {
        const dir = path.join(home, 'ext', name, 'mcp');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'server.js'), '');
        return path.join(dir, 'server.js');
    }
    const launcherVersion = () => readStamp(fs.readFileSync(path.join(home, LAUNCHER_NAME), 'utf8'))?.version;

    test('keeps one record file per install and drops installs that are gone', () => {
        const vscode = fakeInstall('vscode-0.5.1');
        const cursor = fakeInstall('cursor-0.5.1');
        const gone = fakeInstall('gone-0.4.0');
        recordInstall({ version: '0.4.0', server: gone, app: 'Old' }, LAUNCHER_SOURCE, home);
        fs.rmSync(path.dirname(gone), { recursive: true });
        recordInstall({ version: '0.5.1', server: vscode, app: 'VS Code' }, LAUNCHER_SOURCE, home);
        recordInstall({ version: '0.5.1', server: cursor, app: 'Cursor' }, LAUNCHER_SOURCE, home);
        recordInstall({ version: '0.5.1', server: vscode, app: 'VS Code' }, LAUNCHER_SOURCE, home);
        assert.deepStrictEqual(readInstalls(home).map(r => r.app).sort(), ['Cursor', 'VS Code']);
        assert.strictEqual(fs.readdirSync(path.join(home, 'installs')).length, 2);
        if (process.platform !== 'win32') { assert.strictEqual(fs.statSync(home).mode & 0o077, 0, 'the folder is private'); }
    });

    test('installs recording at the same time never lose each other', async () => {
        const servers = ['a', 'b', 'c', 'd', 'e', 'f'].map(fakeInstall);
        await Promise.all(servers.map((server, i) => new Promise<void>(resolve => setImmediate(() => {
            recordInstall({ version: `0.5.${i}`, server, app: `Editor ${i}` }, LAUNCHER_SOURCE, home);
            resolve();
        }))));
        assert.strictEqual(readInstalls(home).length, servers.length);
    });

    test('still reads the installs.json written by 0.5.0', () => {
        const old = fakeInstall('antigravity-0.5.0');
        fs.mkdirSync(home, { recursive: true });
        fs.writeFileSync(path.join(home, 'installs.json'), JSON.stringify([record('0.5.0', old, 1)]));
        recordInstall({ version: '0.5.1', server: fakeInstall('vscode-0.5.1'), app: 'VS Code' }, LAUNCHER_SOURCE, home);
        assert.deepStrictEqual(readInstalls(home).map(r => r.version).sort(), ['0.5.0', '0.5.1']);
    });

    test('an older version never replaces a newer launcher; a newer one does', () => {
        const newer = fakeInstall('cursor-0.6.0');
        const older = fakeInstall('vscode-0.5.1');
        recordInstall({ version: '0.6.0', server: newer, app: 'Cursor' }, LAUNCHER_SOURCE, home);
        recordInstall({ version: '0.5.1', server: older, app: 'VS Code' }, LAUNCHER_SOURCE, home);
        assert.strictEqual(launcherVersion(), '0.6.0');
        recordInstall({ version: '0.7.0', server: older, app: 'VS Code' }, LAUNCHER_SOURCE, home);
        assert.strictEqual(launcherVersion(), '0.7.0');
    });

    test('a rollback replaces the launcher once the newer install is gone', () => {
        const newer = fakeInstall('cursor-0.6.0');
        recordInstall({ version: '0.6.0', server: newer, app: 'Cursor' }, LAUNCHER_SOURCE, home);
        fs.rmSync(path.dirname(newer), { recursive: true });
        recordInstall({ version: '0.5.1', server: fakeInstall('vscode-0.5.1'), app: 'VS Code' }, LAUNCHER_SOURCE, home);
        assert.strictEqual(launcherVersion(), '0.5.1');
    });

    test('the same version does not rewrite the launcher', () => {
        const server = fakeInstall('vscode-0.5.1');
        recordInstall({ version: '0.5.1', server, app: 'VS Code' }, LAUNCHER_SOURCE, home);
        const launcher = path.join(home, LAUNCHER_NAME);
        fs.utimesSync(launcher, new Date(0), new Date(0));
        recordInstall({ version: '0.5.1', server: fakeInstall('antigravity-0.5.1'), app: 'Antigravity' }, LAUNCHER_SOURCE, home);
        assert.strictEqual(fs.statSync(launcher).mtimeMs, 0);
    });

    test('replaces an unstamped launcher (0.5.0) and reads stamps', () => {
        assert.ok(shouldReplaceLauncher(undefined, '0.5.1'));
        assert.ok(shouldReplaceLauncher('"use strict";\n', '0.5.1'));
        const stamp = launcherStamp('0.6.0', '/x/server.js');
        assert.deepStrictEqual(readStamp(stamp + '\nrest'), { version: '0.6.0', server: '/x/server.js' });
        assert.ok(!shouldReplaceLauncher(stamp, '0.6.0', () => true));
        assert.ok(!shouldReplaceLauncher(stamp, '0.5.9', () => true));
        assert.ok(shouldReplaceLauncher(stamp, '0.5.9', () => false));
    });

    test('finds an absolute node path, or falls back to "node"', () => {
        const node = process.platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : '/Users/me/.nvm/versions/node/v22/bin/node';
        assert.strictEqual(findNode(() => `Last login: today\r\n${node}\r\n`), node);
        assert.strictEqual(findNode(() => { throw new Error('no shell'); }), 'node');
        assert.strictEqual(findNode(() => 'node not found'), 'node');
    });

    test('the copied launcher starts the recorded MCP server', async function () {
        this.timeout(15000);
        recordInstall({ version: '0.5.1', server: SERVER, app: 'VS Code' }, LAUNCHER_SOURCE, home);
        const client = new Client({ name: 'launcher-test', version: '0' });
        await client.connect(new StdioClientTransport({
            command: process.execPath,
            args: [path.join(home, LAUNCHER_NAME)],
            env: { ...process.env, BLACKBOX_HOME: home } as Record<string, string>,
        }));
        try {
            assert.strictEqual(client.getServerVersion()?.name, 'blackbox');
            assert.strictEqual((await client.listTools()).tools.length, 33);
        } finally {
            await client.close();
        }
    });

    test('explains what to do when nothing is recorded', () => {
        fs.copyFileSync(LAUNCHER_SOURCE, path.join(home, LAUNCHER_NAME));
        assert.throws(
            () => execFileSync(process.execPath, [path.join(home, LAUNCHER_NAME)], { env: { ...process.env, BLACKBOX_HOME: home }, stdio: 'pipe' }),
            (err: any) => /no Blackbox install recorded/.test(String(err.stderr)),
        );
    });
});
