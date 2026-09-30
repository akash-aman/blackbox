// Path comparison that sees through symlinks, e.g. a WordPress `wp/` link to
// `wordpress-develop/src/`: debuggers report the real path, users and AI
// often pass the link.

import * as fs from 'fs';
import * as path from 'path';

function real(file: string): string {
    try {
        return fs.realpathSync(file);
    } catch {
        return path.resolve(file);
    }
}

export function sameFile(a: string | undefined, b: string | undefined): boolean {
    return !!a && !!b && (a === b || real(a) === real(b));
}
