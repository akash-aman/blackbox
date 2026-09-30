// Registers every tool as a VS Code language model tool, for # references
// in chat. Each must also be declared under contributes.languageModelTools
// in package.json; the contract test keeps the two in step.

import * as vscode from 'vscode';
import { TOOLS } from './catalog';

const input = (options: { input: unknown }) => (options.input ?? {}) as Record<string, any>;

export function registerChatTools(context: vscode.ExtensionContext) {
    for (const [name, tool] of Object.entries(TOOLS)) {
        context.subscriptions.push(vscode.lm.registerTool(name, {
            prepareInvocation: options => ({ invocationMessage: tool.message(input(options)) }),
            invoke: async options => new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(await tool.run(input(options))),
            ]),
        }));
    }
}
