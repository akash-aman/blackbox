// DebugEvents fed with fake Debug Adapter Protocol messages.

import * as assert from 'assert';
import { DebugEvents } from '../../tools/impl/debugEvents';

interface FakeSession { readonly id: string; readonly name: string }

const stopped = (threadId: number, reason = 'breakpoint') => ({ type: 'event', event: 'stopped', body: { reason, threadId } });
const output = (text: string, category = 'stdout') => ({ type: 'event', event: 'output', body: { category, output: text } });
const request = (command: string) => ({ type: 'request', command });

function setup(maxOutput?: number) {
    const hub = new DebugEvents<FakeSession>(maxOutput);
    const parent = { id: 'p', name: 'Launch app' };
    const child = { id: 'c', name: 'app.js' };
    return { hub, parent, child, parentTracker: hub.track(parent), childTracker: hub.track(child) };
}

suite('DebugEvents', () => {
    test('a wait armed before the request sees a fast pause', async () => {
        const { hub, childTracker } = setup();
        const wait = hub.arm();
        childTracker.onWillReceiveMessage(request('next'));
        childTracker.onDidSendMessage(stopped(3, 'step')); // Arrives before anyone awaits.
        const result = await wait(1000);
        assert.strictEqual(result.kind, 'stopped');
        assert.deepStrictEqual(result.kind === 'stopped' && { session: result.session.id, reason: result.stop.reason, thread: result.stop.threadId }, { session: 'c', reason: 'step', thread: 3 });
    });

    test('a pause on a child session satisfies the wait', async () => {
        const { hub, childTracker } = setup();
        const pending = hub.waitForStop(1000);
        childTracker.onDidSendMessage(stopped(1));
        const result = await pending;
        assert.ok(result.kind === 'stopped' && result.session.id === 'c');
    });

    test('waiting while already paused returns at once', async () => {
        const { hub, childTracker } = setup();
        childTracker.onDidSendMessage(stopped(1));
        const result = await hub.waitForStop(1);
        assert.strictEqual(result.kind, 'stopped');
    });

    test('resuming clears the paused state', async () => {
        const { hub, childTracker } = setup();
        childTracker.onDidSendMessage(stopped(1));
        childTracker.onWillReceiveMessage(request('continue'));
        assert.strictEqual(hub.currentStop(), undefined);
        assert.strictEqual((await hub.waitForStop(20)).kind, 'timeout');
    });

    test('a continued event also clears the paused state', () => {
        const { hub, childTracker } = setup();
        childTracker.onDidSendMessage(stopped(1));
        childTracker.onDidSendMessage({ type: 'event', event: 'continued', body: { threadId: 1 } });
        assert.strictEqual(hub.currentStop(), undefined);
    });

    test('times out without a pause', async () => {
        const { hub } = setup();
        assert.strictEqual((await hub.waitForStop(20)).kind, 'timeout');
    });

    test('resolves as terminated when the last session ends', async () => {
        const { hub, parentTracker, childTracker } = setup();
        const pending = hub.waitForStop(1000);
        childTracker.onDidSendMessage({ type: 'event', event: 'terminated' });
        parentTracker.onExit();
        assert.strictEqual((await pending).kind, 'terminated');
        assert.strictEqual((await hub.waitForStop(1000)).kind, 'terminated', 'nothing left to wait for');
    });

    test('keeps output with sequence numbers across sessions', () => {
        const { hub, parentTracker, childTracker } = setup();
        childTracker.onDidSendMessage(output('hello\n'));
        parentTracker.onDidSendMessage(output('logpoint: x=1\n', 'console'));
        parentTracker.onDidSendMessage(output('ignored', 'telemetry'));
        const all = hub.readOutput();
        assert.deepStrictEqual(all.entries.map(e => [e.seq, e.session, e.category, e.text]), [
            [1, 'app.js', 'stdout', 'hello\n'],
            [2, 'Launch app', 'console', 'logpoint: x=1\n'],
        ]);
        assert.strictEqual(all.nextSince, 2);
        assert.deepStrictEqual(hub.readOutput({ since: 1 }).entries.map(e => e.seq), [2]);
        assert.deepStrictEqual(hub.readOutput({ category: 'stdout' }).entries.map(e => e.seq), [1]);
        assert.deepStrictEqual(hub.readOutput({ since: 2 }), { entries: [], nextSince: 2, more: false });
    });

    test('drops the oldest output beyond the limit', () => {
        const { hub, childTracker } = setup(3);
        for (let i = 1; i <= 5; i++) { childTracker.onDidSendMessage(output(`line ${i}`)); }
        assert.deepStrictEqual(hub.readOutput().entries.map(e => e.text), ['line 3', 'line 4', 'line 5']);
        assert.deepStrictEqual(hub.readOutput({ limit: 2 }).entries.map(e => e.seq), [3, 4]);
        assert.strictEqual(hub.readOutput({ limit: 2 }).more, true);
        assert.strictEqual(hub.readOutput({ limit: 2 }).nextSince, 4);
    });

    test('records adapter capabilities from the initialize response', () => {
        const { hub, childTracker } = setup();
        const filters = [{ filter: 'uncaught', label: 'Uncaught Exceptions' }];
        childTracker.onDidSendMessage({ type: 'response', command: 'initialize', success: true, body: { exceptionBreakpointFilters: filters } });
        assert.deepStrictEqual(hub.capabilities('c').exceptionBreakpointFilters, filters);
        assert.deepStrictEqual(hub.capabilities('p'), {});
    });

    test('remembers the last paused thread per session', () => {
        const { hub, childTracker } = setup();
        childTracker.onDidSendMessage(stopped(7));
        assert.strictEqual(hub.lastStop('c')?.threadId, 7);
        assert.strictEqual(hub.lastStop('p'), undefined);
    });

    test('armResponse resolves when the adapter answers that request', async () => {
        const { hub, childTracker } = setup();
        const synced = hub.armResponse('setBreakpoints');
        childTracker.onWillReceiveMessage({ type: 'request', seq: 41, command: 'threads' });
        childTracker.onWillReceiveMessage({ type: 'request', seq: 42, command: 'setBreakpoints' });
        childTracker.onDidSendMessage({ type: 'response', request_seq: 41, success: true });
        childTracker.onDidSendMessage({ type: 'response', request_seq: 42, success: true });
        assert.strictEqual(await synced(1000), true);
    });

    test('armResponse times out, or skips waiting with no live session', async () => {
        const { hub } = setup();
        assert.strictEqual(await hub.armResponse('setBreakpoints')(20), false);
        assert.strictEqual(await new DebugEvents<FakeSession>().armResponse('setBreakpoints')(60_000), false);
    });

    test('filters output by text and shortens huge entries', () => {
        const { hub, childTracker } = setup();
        childTracker.onDidSendMessage(output('xd(2) -> <response>' + 'x'.repeat(3_000_000), 'console'));
        childTracker.onDidSendMessage(output('logpoint: wp_did_header=true\n', 'console'));
        const logpoints = hub.readOutput({ match: 'LOGPOINT' });
        assert.deepStrictEqual(logpoints.entries.map(e => e.text), ['logpoint: wp_did_header=true\n']);
        assert.deepStrictEqual({ nextSince: logpoints.nextSince, more: logpoints.more }, { nextSince: 2, more: false });

        const [huge] = hub.readOutput().entries;
        assert.ok(huge.text.length < 2_100, `entry shortened to ${huge.text.length}`);
        assert.match(huge.text, /more characters\)$/);
    });

    test('keeps a response within its size budget', () => {
        const { hub, childTracker } = setup();
        for (let i = 0; i < 60; i++) { childTracker.onDidSendMessage(output('y'.repeat(1_900))); }
        const page = hub.readOutput();
        const size = page.entries.reduce((n, e) => n + e.text.length, 0);
        assert.ok(size <= 50_000, `response ${size} chars`);
        assert.strictEqual(page.more, true);
        assert.strictEqual(hub.readOutput({ since: page.nextSince }).entries[0].seq, page.nextSince + 1);
    });
});
