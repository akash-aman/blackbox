// Registers every tool on the IPC server for the MCP bridge, plus the
// internal window status tool.

import { IPCServer } from './server';
import { STATUS_TOOL } from './protocol';
import { TOOLS } from '../tools/catalog';
import { getWindowStatus } from '../tools/impl';

export function registerIPCHandlers(ipc: IPCServer) {
    for (const [name, tool] of Object.entries(TOOLS)) {
        ipc.register(name, args => tool.run(args));
    }
    ipc.register(STATUS_TOOL, () => getWindowStatus());
}
