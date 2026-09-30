// Routing policy tests for BridgeSession with fake windows; no sockets.

import * as assert from 'assert';
import { IPCResponse, RegistryEntry, STATUS_TOOL, WindowStatus } from '../../ipc/protocol';
import { IPCError, Send } from '../../ipc/client';
import { BridgeSession, RoutingError, windowLabel } from '../../mcp/session';
import { CURSOR, CURSOR_MAIN_PID, VSCODE_MAIN_PID, makeEntry } from './fixtures';

const entry = (id: string, folders: string[], focusedAt = 0, overrides: Partial<RegistryEntry> = {}): RegistryEntry =>
    makeEntry(id, folders, { focusedAt, ...overrides });

const WPCORE = entry('1', ['/sites/wpcore.wpx'], 2);
const MANHEIM = entry('2', ['/sites/manheim.wpx'], 1);

function harness(initial: RegistryEntry[], cwd: string, env: NodeJS.ProcessEnv = {}, ancestors: number[] = []) {
    let windows = initial;
    const sent: string[] = [];
    const send: Send = async (socket, { tool }) => {
        sent.push(socket);
        if (tool === STATUS_TOOL) {
            if (socket.includes('2')) {
                throw new IPCError('refused', 'ECONNREFUSED');
            }
            const status: WindowStatus = { folders: [], focused: true, breakpoints: 3, debug: { name: 'php', type: 'php', state: 'running' } };
            return { id: '0', result: JSON.stringify(status) };
        }
        return { id: '0', result: socket } as IPCResponse;
    };
    const session = new BridgeSession({ listWindows: () => windows, send, cwd, env, ancestors });
    return { session, sent, setWindows: (w: RegistryEntry[]) => { windows = w; } };
}

function assertRouting(fn: () => unknown, code: string, candidateIds?: string[]) {
    assert.throws(fn, (err: unknown) => {
        assert.ok(err instanceof RoutingError, String(err));
        assert.strictEqual(err.code, code);
        if (candidateIds) {
            assert.deepStrictEqual(err.candidates.map(c => c.id).sort(), candidateIds);
        }
        return true;
    });
}

suite('BridgeSession routing', () => {
    test('picks the single window matching cwd', () => {
        const { session } = harness([WPCORE, MANHEIM], '/sites/manheim.wpx/wp');
        assert.strictEqual(session.resolve().window?.id, '2');
    });

    test('picks the only running window even without a match', () => {
        const { session } = harness([WPCORE], '/Users/me');
        assert.strictEqual(session.resolve().window?.id, '1');
    });

    test('is ambiguous from an unrelated folder with several windows', () => {
        const { session } = harness([WPCORE, MANHEIM], '/Users/me');
        assertRouting(() => session.resolve(), 'AMBIGUOUS', ['1', '2']);
    });

    test('is ambiguous from a parent folder of several windows', () => {
        const { session } = harness([WPCORE, MANHEIM, entry('3', ['/elsewhere'])], '/sites');
        assertRouting(() => session.resolve(), 'AMBIGUOUS', ['1', '2']);
    });

    test('is ambiguous when two windows share the same folder', () => {
        const { session } = harness([WPCORE, entry('9', ['/sites/wpcore.wpx'])], '/sites/wpcore.wpx');
        assertRouting(() => session.resolve(), 'AMBIGUOUS', ['1', '9']);
    });

    test('reports no windows', () => {
        const { session } = harness([], '/sites');
        assertRouting(() => session.resolve(), 'NO_WINDOWS', []);
    });

    test('selects by folder name, path or id and routes there', () => {
        for (const ref of ['manheim.wpx', '/sites/manheim.wpx', '2']) {
            const { session } = harness([WPCORE, MANHEIM], '/Users/me');
            assert.strictEqual(session.select(ref)?.id, '2', ref);
            assert.strictEqual(session.resolve().window?.id, '2', ref);
        }
    });

    test('pinning overrides the cwd match', () => {
        const { session } = harness([WPCORE, MANHEIM], '/sites/wpcore.wpx');
        session.select('manheim.wpx');
        assert.strictEqual(session.resolve().window?.id, '2');
    });

    test('rejects unknown and ambiguous references', () => {
        const { session } = harness([WPCORE, MANHEIM, entry('3', ['/b/wpcore.wpx'])], '/Users/me');
        assertRouting(() => session.select('nope'), 'NOT_FOUND', ['1', '2', '3']);
        assertRouting(() => session.select('wpcore.wpx'), 'AMBIGUOUS', ['1', '3']);
    });

    test('a pin follows its window across a reload', () => {
        const { session, setWindows } = harness([WPCORE, MANHEIM], '/Users/me');
        session.select('manheim.wpx');
        setWindows([WPCORE, entry('22', ['/sites/manheim.wpx'])]);
        assert.strictEqual(session.resolve().window?.id, '22');
        setWindows([WPCORE, entry('23', ['/sites/manheim.wpx'])]);
        assert.strictEqual(session.resolve().window?.id, '23', 'survives a second reload');
    });

    test('a pinned window that closes is an error, not a fallback', () => {
        const { session, setWindows } = harness([WPCORE, MANHEIM], '/sites/wpcore.wpx');
        session.select('manheim.wpx');
        setWindows([WPCORE]);
        assertRouting(() => session.resolve(), 'PIN_GONE', ['1']);
    });

    test('selecting nothing clears the pin', () => {
        const { session } = harness([WPCORE, MANHEIM], '/sites/wpcore.wpx');
        session.select('manheim.wpx');
        assert.strictEqual(session.select(), undefined);
        assert.strictEqual(session.resolve().window?.id, '1');
    });

    test('BLACKBOX_SOCKET overrides everything', () => {
        const { session } = harness([WPCORE, MANHEIM], '/Users/me', { BLACKBOX_SOCKET: '/fake/2.sock' });
        const route = session.resolve();
        assert.strictEqual(route.socket, '/fake/2.sock');
        assert.strictEqual(route.window?.id, '2');
    });

    test('BLACKBOX_WORKSPACE replaces cwd', () => {
        const { session } = harness([WPCORE, MANHEIM], '/Users/me', { BLACKBOX_WORKSPACE: '/sites/wpcore.wpx' });
        assert.strictEqual(session.resolve().window?.id, '1');
    });

    test('call sends to the resolved window', async () => {
        const { session } = harness([WPCORE, MANHEIM], '/sites/manheim.wpx');
        const { route, resp } = await session.call({ tool: 'debug_list_breakpoints', args: {}, timeoutMs: 1000 });
        assert.strictEqual(resp.result, '/fake/2.sock');
        assert.strictEqual(route.windows.length, 2);
    });

    test('describe merges registry, flags and live status', async () => {
        const { session } = harness([WPCORE, MANHEIM], '/sites/wpcore.wpx');
        const [wp, mh] = await session.describe();
        assert.deepStrictEqual(
            { ...wp },
            {
                window: '1', pid: process.pid, app: WPCORE.app, extensionVersion: '0.3.0', outdated: false,
                folders: ['/sites/wpcore.wpx'], matchesCwd: true, selected: true, lastFocused: true, launchedFrom: null,
                reachable: true, breakpoints: 3, debug: { name: 'php', type: 'php', state: 'running' },
            },
        );
        assert.deepStrictEqual(
            { window: mh.window, matchesCwd: mh.matchesCwd, selected: mh.selected, lastFocused: mh.lastFocused, reachable: mh.reachable },
            { window: '2', matchesCwd: false, selected: false, lastFocused: false, reachable: false },
        );
        assert.strictEqual(mh.statusError, 'refused');
    });
});

suite('BridgeSession with several editors', () => {
    // wpcore.wpx open in VS Code and in Cursor.
    const VS = entry('4416', ['/sites/wpcore.wpx'], 1, { pid: 4416 });
    const CU = entry('5000', ['/sites/wpcore.wpx'], 2, { pid: 5000, app: CURSOR, appPid: CURSOR_MAIN_PID });
    const OTHER = entry('6000', ['/sites/manheim.wpx'], 0, { pid: 6000 });

    test('an external terminal is ambiguous, naming both windows', () => {
        const { session } = harness([VS, CU], '/sites/wpcore.wpx');
        assertRouting(() => session.resolve(), 'AMBIGUOUS', ['4416', '5000']);
    });

    test('the chat panel it was started from breaks the tie', () => {
        const { session } = harness([VS, CU], '/sites/wpcore.wpx', {}, [7001, 5000, CURSOR_MAIN_PID]);
        assert.strictEqual(session.resolve().window?.id, '5000');
    });

    test('BLACKBOX_WINDOW from an integrated terminal breaks the tie', () => {
        const { session } = harness([VS, CU], '/sites/wpcore.wpx', { BLACKBOX_WINDOW: '4416' });
        assert.strictEqual(session.resolve().window?.id, '4416');
    });

    test('the launching editor breaks the tie when the window is unknown', () => {
        const { session } = harness([VS, CU], '/sites/wpcore.wpx', {}, [7001, 961, VSCODE_MAIN_PID]);
        assert.strictEqual(session.resolve().window?.id, '4416');
    });

    test('a cwd pointing at another project wins over the launching window', () => {
        const { session } = harness([VS, CU, OTHER], '/sites/manheim.wpx', { BLACKBOX_WINDOW: '4416' });
        assert.strictEqual(session.resolve().window?.id, '6000');
    });

    test('with no cwd match, the launching window is used', () => {
        const { session } = harness([VS, CU, OTHER], '/Users/me', { BLACKBOX_WINDOW: '5000' });
        assert.strictEqual(session.resolve().window?.id, '5000');
    });

    test('select can narrow a folder name to one editor', () => {
        const { session } = harness([VS, CU], '/Users/me');
        assertRouting(() => session.select('wpcore.wpx'), 'AMBIGUOUS', ['4416', '5000']);
        assert.strictEqual(session.select('wpcore.wpx', 'cursor')?.id, '5000');
        assertRouting(() => session.select('wpcore.wpx', 'Antigravity'), 'NOT_FOUND');
    });

    test('labels name the editor only when several editors run', () => {
        assert.strictEqual(windowLabel(CU, [VS, CU]), 'wpcore.wpx (Cursor)');
        assert.strictEqual(windowLabel(VS, [VS, OTHER]), 'wpcore.wpx');
        const OLD = entry('7000', ['/sites/old'], 0, { protocol: 1, app: { name: 'unknown (older extension)', scheme: '', version: '' } });
        assert.strictEqual(windowLabel(VS, [VS, OLD]), 'wpcore.wpx', 'an older window is not another editor');
        assert.strictEqual(windowLabel(OLD, [VS, CU, OLD]), 'old');
    });

    test('a pinned window that reloads is found in its own editor, not another with the same folder', () => {
        // The case seen live: wpcore.wpx open in VS Code and Antigravity, Antigravity reloads.
        const { session, setWindows } = harness([VS, CU], '/Users/me');
        session.select('wpcore.wpx', 'Cursor');
        setWindows([VS]); // Reloading: the old window is gone, the new one not registered yet.
        assertRouting(() => session.resolve(), 'PIN_GONE');
        setWindows([VS, entry('5001', ['/sites/wpcore.wpx'], 3, { pid: 5001, app: CURSOR, appPid: CURSOR_MAIN_PID })]);
        assert.strictEqual(session.resolve().window?.id, '5001');
    });

    test('describe reports editor, launch origin and outdated windows', async () => {
        const OLD = entry('7000', ['/sites/old'], 0, { protocol: 1 });
        const { session } = harness([VS, CU, OLD], '/Users/me', {}, [7001, 5000, CURSOR_MAIN_PID]);
        const views = await session.describe();
        const byId = Object.fromEntries(views.map(v => [v.window, v]));
        assert.strictEqual(byId['5000'].app.name, 'Cursor');
        assert.strictEqual(byId['5000'].launchedFrom, 'window');
        assert.strictEqual(byId['4416'].launchedFrom, null);
        assert.strictEqual(byId['7000'].outdated, true);
    });
});
