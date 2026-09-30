// Connects DebugEvents to VS Code: one tracker per debug session, for every
// debug adapter type.

import * as vscode from 'vscode';
import { DebugEvents } from './debugEvents';

export class DebugEventHub extends DebugEvents<vscode.DebugSession> implements vscode.Disposable {
    private readonly registration: vscode.Disposable;

    constructor() {
        super();
        this.registration = vscode.debug.registerDebugAdapterTrackerFactory('*', {
            createDebugAdapterTracker: session => this.track(session),
        });
    }

    dispose() {
        this.registration.dispose();
    }
}
