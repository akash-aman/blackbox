// Routing policy tests for BridgeSession with fake windows; no sockets.

import * as assert from 'assert';
import { IPCResponse, RegistryEntry, STATUS_TOOL, WindowStatus } from '../../ipc/protocol';
import { IPCError, Send } from '../../ipc/client';
import { BridgeSession, RoutingError } from '../../mcp/session';

const entry = (id: string, folders: string[], focusedAt = 0): RegistryEntry =>
    ({ id, pid: process.pid, socket: `/fake/${id}.sock`, folders, startedAt: 0, focusedAt });

const WPCORE = entry('1', ['/sites/wpcore.wpx'], 2);
const MANHEIM = entry('2', ['/sites/manheim.wpx'], 1);

function harness(initial: RegistryEntry[], cwd: string, env: NodeJS.ProcessEnv = {}) {
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
    const session = new BridgeSession({ listWindows: () => windows, send, cwd, env });
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
        assert.strictEqual(route.windowCount, 2);
    });

    test('describe merges registry, flags and live status', async () => {
        const { session } = harness([WPCORE, MANHEIM], '/sites/wpcore.wpx');
        const [wp, mh] = await session.describe();
        assert.deepStrictEqual(
            { ...wp },
            { window: '1', pid: process.pid, folders: ['/sites/wpcore.wpx'], matchesCwd: true, selected: true, lastFocused: true, reachable: true, breakpoints: 3, debug: { name: 'php', type: 'php', state: 'running' } },
        );
        assert.deepStrictEqual(
            { window: mh.window, matchesCwd: mh.matchesCwd, selected: mh.selected, lastFocused: mh.lastFocused, reachable: mh.reachable },
            { window: '2', matchesCwd: false, selected: false, lastFocused: false, reachable: false },
        );
        assert.strictEqual(mh.statusError, 'refused');
    });
});
