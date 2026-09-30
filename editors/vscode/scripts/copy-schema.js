// Copies schema/tools.json into out/, where the packaged MCP server reads
// it: the repository root is not part of the extension.

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'out'), { recursive: true });
fs.copyFileSync(path.resolve(root, '../../schema/tools.json'), path.join(root, 'out/tools.json'));
