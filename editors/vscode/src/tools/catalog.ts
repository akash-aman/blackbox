// Every tool this extension serves, by name: the single list that both the
// MCP bridge (ipc/handlers.ts) and VS Code's chat tools (tools/chat.ts)
// register from. Names and inputs follow schema/tools.json.

import * as impl from './impl';

type Args = Record<string, any>;

export interface ToolEntry {
    run(args: Args): Promise<string>;
    // Shown in VS Code chat while the tool runs.
    message(args: Args): string;
}

const where = (a: Args) => a.file ? `${a.file}${a.line ? ':' + a.line : ''}` : '';

export const TOOLS: Readonly<Record<string, ToolEntry>> = {
    // Breakpoints
    debug_set_breakpoint: { run: a => impl.setBreakpoint(a as any), message: a => a.breakpoints ? `Setting ${a.breakpoints.length} breakpoints` : `Setting breakpoint at ${where(a)}` },
    debug_set_function_breakpoint: { run: a => impl.setFunctionBreakpoint(a as any), message: a => `Setting function breakpoint on ${a.name}` },
    debug_remove_breakpoint: { run: a => impl.removeBreakpoint(a as any), message: a => a.file ? `Removing breakpoint at ${where(a)}` : 'Removing breakpoints' },
    debug_remove_all_breakpoints: { run: () => impl.removeAllBreakpoints(), message: () => 'Removing all breakpoints' },
    debug_toggle_breakpoints: { run: a => impl.toggleBreakpoints(a as any), message: a => `${a.enabled ? 'Enabling' : 'Disabling'} breakpoints` },
    debug_list_breakpoints: { run: () => impl.listBreakpoints(), message: () => 'Listing breakpoints' },

    // Session control
    debug_get_launch_configs: { run: () => impl.getLaunchConfigs(), message: () => 'Reading launch configurations' },
    debug_start: { run: a => impl.startDebug(a), message: a => `Starting debug session${a.configName ? ' "' + a.configName + '"' : ''}` },
    debug_stop: { run: () => impl.stopDebug(), message: () => 'Stopping debug session' },
    debug_restart: { run: () => impl.restartDebug(), message: () => 'Restarting debug session' },

    // Execution
    debug_continue: { run: a => impl.continueDebug(a as any), message: () => 'Continuing' },
    debug_pause: { run: a => impl.pauseDebug(a as any), message: () => 'Pausing' },
    debug_step_over: { run: a => impl.stepOver(a as any), message: () => 'Stepping over' },
    debug_step_into: { run: a => impl.stepInto(a as any), message: () => 'Stepping into' },
    debug_step_out: { run: a => impl.stepOut(a as any), message: () => 'Stepping out' },
    debug_run_to_line: { run: a => impl.runToLine(a as any), message: a => `Running to ${where(a)}` },
    debug_wait_for_stop: { run: a => impl.waitForStop(a as any), message: () => 'Waiting for the debugger to pause' },

    // Inspection
    debug_list_threads: { run: () => impl.listThreads(), message: () => 'Listing threads' },
    debug_get_stack_trace: { run: a => impl.getStackTrace(a as any), message: () => 'Getting stack trace' },
    debug_get_variables: { run: a => impl.getVariables(a as any), message: a => `Getting variables${a.filter ? ' matching ' + a.filter : ''}` },
    debug_evaluate: { run: a => impl.evaluate(a as any), message: a => `Evaluating ${a.expression}` },
    debug_inspect: { run: a => impl.inspect(a as any), message: a => `Inspecting ${a.variable}` },
    debug_set_variable: { run: a => impl.setVariable(a as any), message: a => `Setting ${a.name} = ${a.value}` },
    debug_watch: { run: a => impl.watch(a as any), message: a => `Watch: ${a.action}` },
    debug_get_source_context: { run: a => impl.getSourceContext(a as any), message: () => 'Reading source around the current line' },
    debug_get_output: { run: a => impl.getOutput(a as any), message: () => 'Reading debug output' },
    debug_set_exception_breakpoints: { run: a => impl.setExceptionBreakpoints(a as any), message: a => a.filters ? `Setting exception breakpoints: ${a.filters.join(', ') || 'none'}` : 'Listing exception filters' },

    // Editor and workspace
    editor_open_file: { run: a => impl.openFile(a as any), message: a => `Opening ${where(a)}` },
    editor_get_open_files: { run: () => impl.getOpenFiles(), message: () => 'Listing open files' },
    workspace_find_file: { run: a => impl.findFile(a as any), message: a => `Finding files: ${a.pattern}` },
    workspace_get_diagnostics: { run: a => impl.getDiagnostics(a as any), message: a => `Getting diagnostics${a.file ? ' for ' + a.file : ''}` },
};
