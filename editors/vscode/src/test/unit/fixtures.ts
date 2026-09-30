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

// For behaviour that exists only on macOS/Linux: permission bits, socket
// files, chmod. On Windows the code skips these checks (named pipes, per-user
// %TEMP%), so the tests are skipped there too.
export const unixOnly = (title: string, fn: Mocha.Func | Mocha.AsyncFunc) => (process.platform === 'win32' ? test.skip(title, fn) : test(title, fn));
