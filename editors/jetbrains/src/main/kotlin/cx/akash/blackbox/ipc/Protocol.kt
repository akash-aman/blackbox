package cx.akash.blackbox.ipc

import com.intellij.openapi.diagnostic.Logger
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Wire-compatible with the VS Code port — see editors/vscode/src/ipc/protocol.ts.
 *
 * Newline-delimited JSON, one message per line:
 *   → { "id": "1", "tool": "debug_set_breakpoint", "args": { "file": "...", "line": 42 } }
 *   ← { "id": "1", "result": "ok: ...:42" }       // or { "id": "1", "error": "..." }
 */
object Protocol {
    const val LOG_NAME = "cx.akash.blackbox"

    /**
     * Per-project Unix-domain socket path. Includes a stable hash of the project's
     * base path so multiple open projects don't collide.
     */
    fun socketPath(projectBasePath: String?): Path {
        val tmp = System.getProperty("java.io.tmpdir") ?: "/tmp"
        val hash = projectBasePath?.hashCode()?.toString(16)?.padStart(8, '0') ?: "default"
        return Paths.get(tmp, "blackbox-jetbrains-$hash.sock")
    }

    fun log(): Logger = Logger.getInstance(LOG_NAME)
}
