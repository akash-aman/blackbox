// Smoke test: start a fake echo socket server, then run the MCP bridge in a
// child process and exchange MCP messages over JSON-RPC.
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SOCK = '/tmp/blackbox-smoke.sock';
try { fs.unlinkSync(SOCK); } catch { }

const fake = net.createServer((client) => {
    client.on('data', (chunk) => {
        const line = chunk.toString().trim();
        try {
            const req = JSON.parse(line);
            client.write(JSON.stringify({ id: req.id, result: 'echo: ' + req.tool }) + '\n');
        } catch (e) { /* ignore */ }
    });
});
fake.listen(SOCK, () => console.error('fake-uds: listening on ' + SOCK));

const bridgePath = path.resolve(__dirname, '..', 'editors', '_shared', 'mcp-bridge', 'src', 'server.js');
const child = spawn(process.execPath, [bridgePath], {
    env: Object.assign({}, process.env, { BLACKBOX_SOCKET: SOCK }),
    stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
child.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 'list') {
            const names = msg.result.tools.map(t => t.name);
            console.log('TOOLS_COUNT=' + names.length);
            console.log('SAMPLE_NAMES=' + names.slice(0, 5).join(','));
            child.stdin.write(JSON.stringify({
                jsonrpc: '2.0', id: 'call',
                method: 'tools/call',
                params: { name: 'debug_list_breakpoints', arguments: {} },
            }) + '\n');
        } else if (msg.id === 'call') {
            console.log('CALL_RESULT=' + JSON.stringify(msg.result));
            child.kill('SIGTERM');
            fake.close();
            setTimeout(() => process.exit(0), 100);
        }
    }
});

setTimeout(() => {
    child.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 'init',
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } },
    }) + '\n');
    setTimeout(() => {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        child.stdin.write(JSON.stringify({
            jsonrpc: '2.0', id: 'list', method: 'tools/list', params: {},
        }) + '\n');
    }, 200);
}, 500);

setTimeout(() => { console.error('SMOKE_TIMEOUT'); process.exit(1); }, 8000);
