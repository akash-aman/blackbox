// Registers all tool handlers on the IPC server.
// Each handler delegates to shared implementations in tools/impl/.

import { IPCServer } from './server';
import * as impl from '../tools/impl';
import { STATUS_TOOL } from './protocol';

export function registerIPCHandlers(ipc: IPCServer) {

    // ── Breakpoints ─────────────────────────────────────────────
    ipc.register('debug_set_breakpoint', async (args) => impl.setBreakpoint(args as any));
    ipc.register('debug_remove_breakpoint', async (args) => impl.removeBreakpoint(args as any));
    ipc.register('debug_remove_all_breakpoints', async () => impl.removeAllBreakpoints());
    ipc.register('debug_list_breakpoints', async () => impl.listBreakpoints());

    // ── Session Control ─────────────────────────────────────────
    ipc.register('debug_start', async (args) => impl.startDebug(args));
    ipc.register('debug_stop', async () => impl.stopDebug());
    ipc.register('debug_continue', async (args) => impl.continueDebug(args as any));
    ipc.register('debug_pause', async (args) => impl.pauseDebug(args as any));
    ipc.register('debug_step_over', async (args) => impl.stepOver(args as any));
    ipc.register('debug_step_into', async (args) => impl.stepInto(args as any));
    ipc.register('debug_step_out', async (args) => impl.stepOut(args as any));
    ipc.register('debug_restart', async () => impl.restartDebug());

    // ── Inspection ──────────────────────────────────────────────
    ipc.register('debug_evaluate', async (args) => impl.evaluate(args as any));
    ipc.register('debug_get_variables', async (args) => impl.getVariables(args as any));
    ipc.register('debug_get_stack_trace', async () => impl.getStackTrace());
    ipc.register('debug_get_launch_configs', async () => impl.getLaunchConfigs());
    ipc.register('debug_inspect', async (args) => impl.inspect(args as any));
    ipc.register('debug_watch', async (args) => impl.watch(args as any));
    ipc.register('debug_wait_for_stop', async (args) => impl.waitForStop(args as any));
    ipc.register('debug_get_output', async (args) => impl.getOutput(args as any));
    ipc.register('debug_set_exception_breakpoints', async (args) => impl.setExceptionBreakpoints(args as any));

    // ── Editor ──────────────────────────────────────────────────
    ipc.register('editor_open_file', async (args) => impl.openFile(args as any));
    ipc.register('editor_get_open_files', async () => impl.getOpenFiles());

    // ── Workspace ───────────────────────────────────────────────
    ipc.register('workspace_find_file', async (args) => impl.findFile(args as any));
    ipc.register('workspace_get_diagnostics', async (args) => impl.getDiagnostics(args as any));

    // ── Bridge ──────────────────────────────────────────────────
    ipc.register(STATUS_TOOL, async () => impl.getWindowStatus());
}
