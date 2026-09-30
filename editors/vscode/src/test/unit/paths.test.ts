// Path comparison through symlinks (e.g. WordPress wp/ -> wordpress-develop/src/).

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sameFile } from '../../util/paths';

suite('sameFile', () => {
    test('treats a symlinked path and its real path as the same file', () => {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bbx-link-')));
        try {
            fs.mkdirSync(path.join(root, 'src'));
            fs.writeFileSync(path.join(root, 'src', 'index.php'), '<?php');
            fs.symlinkSync(path.join(root, 'src'), path.join(root, 'wp'));
            assert.ok(sameFile(path.join(root, 'wp', 'index.php'), path.join(root, 'src', 'index.php')));
            assert.ok(!sameFile(path.join(root, 'wp', 'index.php'), path.join(root, 'src', 'other.php')));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('compares missing files by resolved path, and never matches undefined', () => {
        assert.ok(sameFile('/nope/a/../b.php', '/nope/b.php'));
        assert.ok(!sameFile(undefined, '/x.php'));
    });
});
