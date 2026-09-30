// The AI debugging loop against the built-in Node debugger, driven through
// this window's bridge socket exactly as the MCP server drives it.
// Uses test-fixtures/app.js and its "Fixture" launch configuration.

import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { listWindows } from '../../ipc/registry';
import { callExtension } from '../../ipc/client';

const FIXTURE = path.resolve(__dirname, '../../../test-fixtures/app.js');
const BREAKPOINT_LINE = 9;
const LOGPOINT_LINE = 10;
const EXCEPTION_LINE = 13;

async function call(tool: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<string> {
    const self = listWindows().find(w => w.pid === process.pid)!;
    const resp = await callExtension(self.socket, { tool, args, timeoutMs });
    if (resp.error) { throw new Error(`${tool}: ${resp.error}`); }
    return resp.result ?? '';
}

const callJson = async (tool: string, args: Record<string, unknown> = {}, timeoutMs?: number) => JSON.parse(await call(tool, args, timeoutMs));

suite('Debug loop (Node fixture)', () => {
    suiteTeardown(async () => {
        await vscode.debug.stopDebugging();
        vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    });

    test('start by name, wait, step, read logpoints, stop on exceptions', async function () {
        this.timeout(90_000);

        await call('debug_set_breakpoint', { breakpoints: [
            { file: FIXTURE, line: BREAKPOINT_LINE },
            { file: FIXTURE, line: LOGPOINT_LINE, logMessage: 'logpoint total={total}' },
        ] });

        assert.match(await call('debug_start', { configName: 'Fixture' }), /started/);

        const hit = await callJson('debug_wait_for_stop', { timeoutMs: 30_000 }, 35_000);
        assert.strictEqual(hit.state, 'stopped', JSON.stringify(hit));
        assert.strictEqual(hit.reason, 'breakpoint');
        assert.strictEqual(hit.line, BREAKPOINT_LINE);
        assert.ok(hit.file.endsWith('app.js'));

        const stepped = await callJson('debug_step_over');
        assert.strictEqual(stepped.state, 'stopped', JSON.stringify(stepped));
        assert.strictEqual(stepped.line, LOGPOINT_LINE);

        const filters = await callJson('debug_set_exception_breakpoints');
        const ids = filters.available.map((f: { filter: string }) => f.filter);
        assert.ok(ids.includes('all'), `Node filters: ${ids.join(', ')}`);
        assert.match(await call('debug_set_exception_breakpoints', { filters: ['all'] }), /all/);

        await call('debug_remove_breakpoint', { file: FIXTURE, line: BREAKPOINT_LINE });
        assert.match(await call('debug_continue'), /debug_wait_for_stop/);

        const thrown = await callJson('debug_wait_for_stop', { timeoutMs: 30_000 }, 35_000);
        assert.strictEqual(thrown.state, 'stopped', JSON.stringify(thrown));
        assert.strictEqual(thrown.reason, 'exception', JSON.stringify(thrown));
        assert.strictEqual(thrown.line, EXCEPTION_LINE);

        const output = await callJson('debug_get_output');
        const texts = output.entries.map((e: { text: string }) => e.text).join('');
        assert.match(texts, /logpoint total=1/);
        assert.match(texts, /logpoint total=3/);
        assert.ok(output.nextSince > 0);

        assert.match(await call('debug_stop'), /stopped/);
        const ended = await callJson('debug_wait_for_stop', { timeoutMs: 10_000 }, 15_000);
        assert.strictEqual(ended.state, 'terminated');
    });

    test('an unknown launch configuration name lists the available ones', async () => {
        await assert.rejects(call('debug_start', { configName: 'Nope' }), /Available: Fixture/);
    });

    test('hit counts, threads, frames, set variable, toggle, function breakpoints, run to line', async function () {
        this.timeout(90_000);
        vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);

        await call('debug_set_breakpoint', { file: FIXTURE, line: BREAKPOINT_LINE, hitCondition: '2' });
        await call('debug_start', { configName: 'Fixture' });
        const hit = await callJson('debug_wait_for_stop', { timeoutMs: 30_000 }, 35_000);
        assert.strictEqual(hit.line, BREAKPOINT_LINE, JSON.stringify(hit));
        assert.strictEqual((await callJson('debug_evaluate', { expression: 'i' })).result, '2', 'hit condition skips the first pass');

        const { threads } = await callJson('debug_list_threads');
        assert.ok(threads.some((t: { id: number; stopped?: boolean }) => t.id === hit.threadId && t.stopped), JSON.stringify(threads));

        const context = await callJson('debug_get_source_context', { lines: 1 });
        assert.deepStrictEqual(context.lines.map((l: { line: number }) => l.line), [BREAKPOINT_LINE - 1, BREAKPOINT_LINE, BREAKPOINT_LINE + 1]);
        assert.match(context.lines.find((l: { current?: boolean }) => l.current).text, /total = add\(total, i\)/);

        const frames = await callJson('debug_get_stack_trace', { levels: 2 });
        assert.strictEqual(frames.length, 2);
        const locals = await callJson('debug_get_variables', { frameId: frames[0].id, filter: 'total' });
        assert.ok(JSON.stringify(locals).includes('"total"'), JSON.stringify(locals));

        assert.match(await call('debug_set_variable', { name: 'total', value: '100' }), /100/);
        assert.strictEqual((await callJson('debug_evaluate', { expression: 'total' })).result, '100');

        assert.match(await call('debug_toggle_breakpoints', { enabled: false }), /Disabled 1/);
        assert.strictEqual((await callJson('debug_list_breakpoints'))[0].enabled, false);
        assert.match(await call('debug_toggle_breakpoints', { enabled: true, breakpoints: [{ file: FIXTURE, line: BREAKPOINT_LINE }] }), /Enabled 1/);
        assert.strictEqual((await callJson('debug_list_breakpoints'))[0].hitCondition, '2', 'toggling keeps the hit condition');

        assert.match(await call('debug_set_function_breakpoint', { name: 'add' }), /ok: function add/);
        assert.ok((await callJson('debug_list_breakpoints')).some((b: { type: string; name?: string }) => b.type === 'function' && b.name === 'add'));
        assert.match(await call('debug_remove_breakpoint', { functions: ['add'] }), /removed function add/);

        const reached = await callJson('debug_run_to_line', { file: FIXTURE, line: LOGPOINT_LINE, timeoutMs: 20_000 }, 35_000);
        assert.strictEqual(reached.reachedTarget, true, JSON.stringify(reached));
        const lines = (await callJson('debug_list_breakpoints')).map((b: { line?: number }) => b.line);
        assert.deepStrictEqual(lines, [BREAKPOINT_LINE], 'the temporary breakpoint is removed');

        await call('debug_remove_all_breakpoints');
        await call('debug_continue');
        assert.strictEqual((await callJson('debug_wait_for_stop', { timeoutMs: 20_000 }, 25_000)).state, 'terminated');
        const out = (await callJson('debug_get_output', { match: 'total 102' })).entries;
        assert.strictEqual(out.length, 1, 'the changed variable reached the program output');
    });
});
