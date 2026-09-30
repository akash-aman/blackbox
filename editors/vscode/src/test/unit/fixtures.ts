// Shared test data for the node-only unit tests.

import { AppInfo, PROTOCOL_VERSION, RegistryEntry } from '../../ipc/protocol';

export const VSCODE: AppInfo = { name: 'Visual Studio Code', scheme: 'vscode', version: '1.139.1' };
export const CURSOR: AppInfo = { name: 'Cursor', scheme: 'cursor', version: '1.9.0' };

export const VSCODE_MAIN_PID = 845;
export const CURSOR_MAIN_PID = 900;

export function makeEntry(id: string, folders: string[], overrides: Partial<RegistryEntry> = {}): RegistryEntry {
    return {
        id,
        pid: process.pid,
        socket: `/fake/${id}.sock`,
        folders,
        startedAt: 0,
        focusedAt: 0,
        app: VSCODE,
        appPid: VSCODE_MAIN_PID,
        extensionVersion: '0.3.0',
        protocol: PROTOCOL_VERSION,
        ...overrides,
    };
}
