// Thin wrappers that register languageModelTools for # references in chat.
// All logic lives in ./impl/debug.ts — these just bridge to LM tool format.

import * as vscode from 'vscode';
import * as impl from './impl/debug';

const i = (o: { input: unknown }) => (o.input ?? {}) as Record<string, any>;
const txt = (text: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);

export function registerDebugTools(context: vscode.ExtensionContext) {

    context.subscriptions.push(vscode.lm.registerTool('debug_set_breakpoint', {
        prepareInvocation(options, _token) { const inp = i(options); return { invocationMessage: `Setting breakpoint at ${inp.file}:${inp.line}` }; },
        async invoke(options, _token) { return txt(await impl.setBreakpoint(options.input as any)); },
    }));

    context.subscriptions.push(vscode.lm.registerTool('debug_remove_breakpoint', {
        prepareInvocation(options, _token) { const inp = i(options); return { invocationMessage: `Removing breakpoint at ${inp.file}:${inp.line}` }; },
        async invoke(options, _token) { return txt(await impl.removeBreakpoint(options.input as any)); },
    }));

    context.subscriptions.push(vscode.lm.registerTool('debug_list_breakpoints', {
        prepareInvocation(_options, _token) { return { invocationMessage: 'Listing all breakpoints' }; },
        async invoke(_options, _token) { return txt(await impl.listBreakpoints()); },
    }));

    context.subscriptions.push(vscode.lm.registerTool('debug_start', {
        prepareInvocation(options, _token) { return { invocationMessage: `Starting debug session` }; },
        async invoke(options, _token) { return txt(await impl.startDebug(options.input as any)); },
    }));

    context.subscriptions.push(vscode.lm.registerTool('debug_stop', {
        prepareInvocation(_options, _token) { return { invocationMessage: 'Stopping debug session' }; },
        async invoke(_options, _token) { return txt(await impl.stopDebug()); },
    }));

    context.subscriptions.push(vscode.lm.registerTool('debug_evaluate', {
        prepareInvocation(options, _token) { return { invocationMessage: `Evaluating: ${i(options).expression}` }; },
        async invoke(options, _token) { return txt(await impl.evaluate(options.input as any)); },
    }));

    context.subscriptions.push(vscode.lm.registerTool('debug_get_variables', {
        prepareInvocation(_options, _token) { return { invocationMessage: 'Getting variables from current scope' }; },
        async invoke(options, _token) { return txt(await impl.getVariables(options.input as any)); },
    }));

    context.subscriptions.push(vscode.lm.registerTool('debug_get_stack_trace', {
        prepareInvocation(_options, _token) { return { invocationMessage: 'Getting stack trace' }; },
        async invoke(_options, _token) { return txt(await impl.getStackTrace()); },
    }));
}
