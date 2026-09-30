// Version-independent entry point for MCP clients:
//
//   { "command": "node", "args": ["<home>/.blackbox/blackbox-mcp.js"] }
//
// Every activation of the extension, in any editor (VS Code, Cursor,
// Antigravity, ...), records its install in ~/.blackbox/installs.json and
// copies this file to ~/.blackbox/blackbox-mcp.js. Run with node, it starts
// the MCP server of the newest recorded install that still exists, so MCP
// configs keep working when an editor updates the extension.
//
// Self-contained on purpose (Node built-ins only): it runs from ~/.blackbox,
// outside any extension folder.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

const installsFile = (home: string) => path.join(home, 'installs.json');

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

export function readInstalls(home = blackboxHome()): InstallRecord[] {
    try {
        const records = JSON.parse(fs.readFileSync(installsFile(home), 'utf8'));
        return Array.isArray(records) ? records : [];
    } catch {
        return [];
    }
}

// The newest install whose server still exists.
export function pickServer(records: readonly InstallRecord[], exists: (file: string) => boolean = fs.existsSync): InstallRecord | undefined {
    return records
        .filter(r => typeof r.server === 'string' && exists(r.server))
        .sort((a, b) => compareVersions(b.version, a.version) || b.recordedAt - a.recordedAt)[0];
}

function writeAtomic(file: string, content: string) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, file);
}

// Records this install, drops records whose files are gone, and refreshes
// the launcher copy. Called by the extension on activation.
export function recordInstall(install: Omit<InstallRecord, 'recordedAt'>, launcherSource: string, home = blackboxHome()) {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const others = readInstalls(home).filter(r => r.server !== install.server && fs.existsSync(r.server));
    writeAtomic(installsFile(home), JSON.stringify([...others, { ...install, recordedAt: Date.now() }], null, 2) + '\n');

    const launcher = path.join(home, LAUNCHER_NAME);
    const source = fs.readFileSync(launcherSource, 'utf8');
    const current = fs.existsSync(launcher) ? fs.readFileSync(launcher, 'utf8') : '';
    if (current !== source) {
        writeAtomic(launcher, source);
    }
}

function main() {
    const home = blackboxHome();
    const chosen = pickServer(readInstalls(home));
    if (!chosen) {
        console.error(`blackbox-mcp: no Blackbox install recorded in ${installsFile(home)}. `
            + 'Open a folder in VS Code (or another VS Code-based editor) with the Blackbox extension enabled, then try again.');
        process.exit(1);
    }
    require(chosen.server);
}

if (require.main === module) {
    main();
}
