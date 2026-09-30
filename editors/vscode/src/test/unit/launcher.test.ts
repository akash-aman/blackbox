// The version-independent MCP launcher (~/.blackbox/blackbox-mcp.js).

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InstallRecord, LAUNCHER_NAME, compareVersions, pickServer, readInstalls, recordInstall } from '../../launcher/blackboxMcp';

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

    test('records installs, replaces its own record and drops missing ones', () => {
        fs.writeFileSync(path.join(home, 'installs.json'), JSON.stringify([record('0.1.0', '/gone/server.js'), record('0.2.0', SERVER)]));
        recordInstall({ version: '0.5.0', server: SERVER, app: 'VS Code' }, LAUNCHER_SOURCE, home);
        const installs = readInstalls(home);
        assert.deepStrictEqual(installs.map(r => [r.version, r.server]), [['0.5.0', SERVER]]);
        assert.strictEqual(fs.readFileSync(path.join(home, LAUNCHER_NAME), 'utf8'), fs.readFileSync(LAUNCHER_SOURCE, 'utf8'));
        assert.strictEqual(fs.statSync(home).mode & 0o077, 0, 'the folder is private');
    });

    test('the copied launcher starts the recorded MCP server', async function () {
        this.timeout(15000);
        recordInstall({ version: '0.5.0', server: SERVER, app: 'VS Code' }, LAUNCHER_SOURCE, home);
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
