// Writes contributes.languageModelTools in package.json from
// schema/tools.json, so VS Code chat offers the same tools as MCP.
// Bridge-only tools (ide_*) are left out: inside a window there is only
// that window. Run with `npm run sync:tools`; the contract test fails if
// package.json is out of date.

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const schema = JSON.parse(fs.readFileSync(path.resolve(root, '../../schema/tools.json'), 'utf8'));
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

pkg.contributes.languageModelTools = schema.tools
    .filter(tool => !tool.name.startsWith('ide_'))
    .map(tool => ({
        name: tool.name,
        displayName: tool.displayName,
        toolReferenceName: tool.name,
        canBeReferencedInPrompt: true,
        userDescription: tool.description,
        modelDescription: tool.description,
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
    }));

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + '\n');
console.log(`package.json: ${pkg.contributes.languageModelTools.length} chat tools`);
