// Version-independent entry point for MCP clients:
//
//   { "command": "node", "args": ["<home>/.blackbox/blackbox-mcp.js"] }
//
// Every activation of the extension, in any editor (VS Code, Cursor,
// Antigravity, ...), records its install in ~/.blackbox/installs/ (one file
// per install, so windows starting together can't lose each other's record)
// and copies this file to ~/.blackbox/blackbox-mcp.js unless a newer
// version's copy is already there. Run with node, it starts the MCP server
// of the newest recorded install that still exists, so MCP configs keep
// working when an editor updates the extension.
//
// Self-contained on purpose (Node built-ins only): it runs from ~/.blackbox,
// outside any extension folder.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

export interface InstallRecord {
    version: string;
    server: string;     // Absolute path of out/mcp/server.js.
    app: string;        // Editor that last recorded it.
    recordedAt: number;
}

export const LAUNCHER_NAME = 'blackbox-mcp.js';

export function blackboxHome(): string {
    return process.env.BLACKBOX_HOME || path.join(os.homedir(), '.blackbox');
}

const installsDir = (home: string) => path.join(home, 'installs');
// Written by 0.5.0; still read so its installs count until they update.
const legacyInstallsFile = (home: string) => path.join(home, 'installs.json');

// Compares "1.2.3" style versions numerically; a pre-release suffix
// ("1.2.3-beta") sorts before the plain version.
export function compareVersions(a: string, b: string): number {
    const parse = (v: string) => {
        const [core, pre] = v.split('-', 2);
        return { parts: core.split('.').map(n => parseInt(n, 10) || 0), pre };
    };
    const x = parse(a);
    const y = parse(b);
    for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
        const diff = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
        if (diff !== 0) { return diff; }
    }
    if (x.pre === y.pre) { return 0; }
    if (!x.pre) { return 1; }
    if (!y.pre) { return -1; }
    return x.pre < y.pre ? -1 : 1;
}

function readJson(file: string): unknown {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return undefined;
    }
}

export function readInstalls(home = blackboxHome()): InstallRecord[] {
    const legacy = readJson(legacyInstallsFile(home));
    let names: string[] = [];
    try { names = fs.readdirSync(installsDir(home)).filter(n => n.endsWith('.json')); } catch { /* none yet */ }
    const records = [
        ...(Array.isArray(legacy) ? legacy : []),
        ...names.map(n => readJson(path.join(installsDir(home), n))),
    ].filter((r): r is InstallRecord => !!r && typeof (r as InstallRecord).server === 'string');

    // One record per server file: the most recent.
    const byServer = new Map<string, InstallRecord>();
    for (const r of records) {
        const key = process.platform === 'win32' ? r.server.toLowerCase() : r.server;
        const seen = byServer.get(key);
        if (!seen || r.recordedAt > seen.recordedAt) { byServer.set(key, r); }
    }
    return [...byServer.values()];
}

// The newest install whose server still exists.
export function pickServer(records: readonly InstallRecord[], exists: (file: string) => boolean = fs.existsSync): InstallRecord | undefined {
    return records
        .filter(r => typeof r.server === 'string' && exists(r.server))
        .sort((a, b) => compareVersions(b.version, a.version) || b.recordedAt - a.recordedAt)[0];
}

function writeAtomic(file: string, content: string) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, file);
}

// First line of the installed launcher: which version wrote it, from where.
const STAMP = /^\/\/ blackbox-mcp launcher v(\S+) from (.+)$/;

export function launcherStamp(version: string, server: string): string {
    return `// blackbox-mcp launcher v${version} from ${server}`;
}

export function readStamp(content: string | undefined): { version: string; server: string } | undefined {
    const match = content?.split('\n', 1)[0].match(STAMP);
    return match ? { version: match[1], server: match[2] } : undefined;
}

// Replace the installed launcher only with a newer one, or when the install
// that wrote it is gone (e.g. rolled back). Never downgrade a live one.
export function shouldReplaceLauncher(current: string | undefined, version: string, exists: (file: string) => boolean = fs.existsSync): boolean {
    const stamp = readStamp(current);
    if (!stamp) { return true; }
    return compareVersions(version, stamp.version) > 0 || !exists(stamp.server);
}

// Records this install, removes records of installs that are gone, and
// installs this version's launcher if appropriate. Called on activation.
export function recordInstall(install: Omit<InstallRecord, 'recordedAt'>, launcherSource: string, home = blackboxHome()) {
    fs.mkdirSync(installsDir(home), { recursive: true, mode: 0o700 });
    fs.chmodSync(home, 0o700);

    // Windows paths are case-insensitive ("d:\\" and "D:\\" are one install).
    const key = process.platform === 'win32' ? install.server.toLowerCase() : install.server;
    const id = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
    writeAtomic(path.join(installsDir(home), `${id}.json`), JSON.stringify({ ...install, recordedAt: Date.now() }, null, 2) + '\n');
    for (const name of fs.readdirSync(installsDir(home)).filter(n => n.endsWith('.json'))) {
        const record = readJson(path.join(installsDir(home), name)) as InstallRecord | undefined;
        if (record && !fs.existsSync(record.server)) {
            try { fs.unlinkSync(path.join(installsDir(home), name)); } catch { /* another window got it */ }
        }
    }

    const launcher = path.join(home, LAUNCHER_NAME);
    const current = fs.existsSync(launcher) ? fs.readFileSync(launcher, 'utf8') : undefined;
    if (shouldReplaceLauncher(current, install.version)) {
        writeAtomic(launcher, `${launcherStamp(install.version, install.server)}\n${fs.readFileSync(launcherSource, 'utf8')}`);
    }
}

// Absolute path of the user's node, for MCP configs: apps started from the
// Dock often lack nvm & co. on their PATH. Falls back to plain "node".
export function findNode(run: (cmd: string, args: string[]) => string = (cmd, args) =>
    execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })): string {
    try {
        const out = process.platform === 'win32'
            ? run('where', ['node'])
            : run(process.env.SHELL || '/bin/sh', ['-lc', 'command -v node']);
        const found = out.split(/\r?\n/).map(l => l.trim()).find(l => path.isAbsolute(l));
        return found ?? 'node';
    } catch {
        return 'node';
    }
}

function main() {
    const home = blackboxHome();
    const chosen = pickServer(readInstalls(home));
    if (!chosen) {
        console.error(`blackbox-mcp: no Blackbox install recorded in ${installsDir(home)}. `
            + 'Open a folder in VS Code (or another VS Code-based editor) with the Blackbox extension enabled, then try again.');
        process.exit(1);
    }
    require(chosen.server);
}

if (require.main === module) {
    main();
}
