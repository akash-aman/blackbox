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

// Picks the window for `cwd`:
//   1. the window with the deepest workspace folder containing cwd,
//   2. otherwise a window with a folder inside cwd,
//   3. otherwise the most recently focused window.
export function pickWindow(entries: RegistryEntry[], cwd: string): RegistryEntry | undefined {
    const target = normalize(cwd);
    let best: RegistryEntry | undefined;
    let bestScore = -1;

    for (const entry of entries) {
        for (const folder of entry.folders.map(normalize)) {
            let score = -1;
            if (contains(folder, target)) {
                score = 2_000_000 + folder.length;
            } else if (contains(target, folder)) {
                score = 1_000_000 - folder.length;
            }
            if (score > bestScore || (score === bestScore && best && entry.focusedAt > best.focusedAt)) {
                best = entry;
                bestScore = score;
            }
        }
    }
    if (best) {
        return best;
    }
    return [...entries].sort((a, b) => b.focusedAt - a.focusedAt)[0];
}
