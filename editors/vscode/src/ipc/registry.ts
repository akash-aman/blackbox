// Discovery of running VS Code windows. Used by the MCP server to decide
// which extension host a tool call should go to.

import * as fs from 'fs';
import * as path from 'path';
import { RegistryEntry, ipcDir } from './protocol';

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err: unknown) {
        // EPERM means the process exists but belongs to someone else.
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}

// Returns registry entries of live windows. Entries left behind by crashed
// extension hosts are removed along with their sockets.
export function listWindows(): RegistryEntry[] {
    const dir = ipcDir();
    let names: string[];
    try {
        names = fs.readdirSync(dir).filter(n => n.endsWith('.json'));
    } catch {
        return [];
    }

    const entries: RegistryEntry[] = [];
    for (const name of names) {
        const file = path.join(dir, name);
        let entry: RegistryEntry;
        try {
            entry = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            continue; // Partially written or foreign file.
        }
        if (!isAlive(entry.pid)) {
            try { fs.unlinkSync(file); } catch { /* ignore */ }
            try { fs.unlinkSync(entry.socket); } catch { /* ignore */ }
            continue;
        }
        entries.push(entry);
    }
    return entries;
}

function normalize(p: string): string {
    let resolved = path.resolve(p);
    try { resolved = fs.realpathSync(resolved); } catch { /* keep as is */ }
    // macOS and Windows file systems are case-insensitive by default.
    return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

function contains(folder: string, target: string): boolean {
    return target === folder || target.startsWith(folder.endsWith(path.sep) ? folder : folder + path.sep);
}

const NO_MATCH = -1;

// Returns the windows that best match `dir`, with no fallback:
//   1. windows whose folder contains dir, keeping only the deepest folder,
//   2. otherwise windows with a folder inside dir.
// An empty result means no match; more than one means it is ambiguous.
export function matchWindows(entries: readonly RegistryEntry[], dir: string): RegistryEntry[] {
    const target = normalize(dir);
    const folders = entries.map(e => e.folders.map(normalize));
    const depths = folders.map(fs => Math.max(NO_MATCH, ...fs.filter(f => contains(f, target)).map(f => f.length)));
    const deepest = Math.max(NO_MATCH, ...depths);

    if (deepest !== NO_MATCH) {
        return entries.filter((_, i) => depths[i] === deepest);
    }
    return entries.filter((_, i) => folders[i].some(f => contains(target, f)));
}

// Resolves a user-supplied window reference: an exact id, then a path,
// then a folder name (case-insensitive).
export function findWindows(entries: readonly RegistryEntry[], ref: string): RegistryEntry[] {
    const byId = entries.filter(e => e.id === ref);
    if (byId.length > 0) {
        return byId;
    }
    if (path.isAbsolute(ref)) {
        return matchWindows(entries, ref);
    }
    const name = ref.toLowerCase();
    return entries.filter(e => e.folders.some(f => path.basename(f).toLowerCase() === name));
}
