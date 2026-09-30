import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    // Opened as the test window's workspace; holds the debug-loop fixture.
    const fixtureWorkspace = path.resolve(extensionDevelopmentPath, 'test-fixtures');

    await runTests({
        extensionDevelopmentPath,
        extensionTestsPath,
        launchArgs: [fixtureWorkspace, '--disable-extensions'],
        // Keep the MCP launcher and install records out of the real ~/.blackbox.
        extensionTestsEnv: { BLACKBOX_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'bbx-home-')) },
    });
}

main().catch(err => {
    console.error('Failed to run tests:', err);
    process.exit(1);
});
