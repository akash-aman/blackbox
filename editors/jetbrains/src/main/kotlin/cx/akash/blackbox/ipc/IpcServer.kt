package cx.akash.blackbox.ipc

import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import cx.akash.blackbox.tools.ToolRegistry
import cx.akash.blackbox.util.Json
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.StandardProtocolFamily
import java.net.UnixDomainSocketAddress
import java.nio.channels.Channels
import java.nio.channels.ServerSocketChannel
import java.nio.channels.SocketChannel
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Per-project Unix-domain-socket server. Wire-compatible with the VS Code IPC layer
 * (see editors/vscode/src/ipc/server.ts).
 */
@Service(Service.Level.PROJECT)
class IpcServer(private val project: Project) : Disposable {
    private val log: Logger = Protocol.log()
    private val running = AtomicBoolean(false)
    private val acceptExecutor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "blackbox-ipc-accept").apply { isDaemon = true }
    }
    private val workerExecutor = Executors.newCachedThreadPool { r ->
        Thread(r, "blackbox-ipc-worker").apply { isDaemon = true }
    }
    private var serverChannel: ServerSocketChannel? = null
    private var socketPath: Path? = null

    fun start() {
        if (!running.compareAndSet(false, true)) return
        val path = Protocol.socketPath(project.basePath)
        socketPath = path
        try { Files.deleteIfExists(path) } catch (_: Exception) { /* ignore */ }

        val channel = ServerSocketChannel.open(StandardProtocolFamily.UNIX)
        channel.bind(UnixDomainSocketAddress.of(path))
        serverChannel = channel
        log.info("Blackbox IPC: listening on $path")

        acceptExecutor.submit {
            while (running.get()) {
                val client = try { channel.accept() } catch (t: Throwable) {
                    if (running.get()) log.warn("accept failed", t)
                    null
                }
                if (client != null) workerExecutor.submit { handleClient(client) }
            }
        }
    }

    private fun handleClient(client: SocketChannel) {
        client.use { ch ->
            val reader = BufferedReader(InputStreamReader(Channels.newInputStream(ch), StandardCharsets.UTF_8))
            val out = Channels.newOutputStream(ch)
            try {
                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.isBlank()) continue
                    val response = dispatch(line)
                    out.write((response + "\n").toByteArray(StandardCharsets.UTF_8))
                    out.flush()
                }
            } catch (t: Throwable) {
                log.warn("client error", t)
            }
        }
    }

    private fun dispatch(line: String): String {
        val req = try { Json.parse(line) } catch (t: Throwable) {
            return Json.stringify(mapOf("id" to "", "error" to "invalid json: ${t.message}"))
        }
        val id = req.get("id")?.asString ?: ""
        val tool = req.get("tool")?.asString
            ?: return Json.stringify(mapOf("id" to id, "error" to "missing tool name"))
        val args = req.get("args")?.takeIf { it.isJsonObject }?.asJsonObject ?: com.google.gson.JsonObject()
        return try {
            val result = ToolRegistry.invoke(project, tool, args)
            Json.stringify(mapOf("id" to id, "result" to result))
        } catch (t: Throwable) {
            log.warn("tool '$tool' failed", t)
            Json.stringify(mapOf("id" to id, "error" to (t.message ?: t::class.java.simpleName)))
        }
    }

    fun stop() {
        if (!running.compareAndSet(true, false)) return
        try { serverChannel?.close() } catch (_: Exception) { /* ignore */ }
        try { socketPath?.let { Files.deleteIfExists(it) } } catch (_: Exception) { /* ignore */ }
        acceptExecutor.shutdownNow()
        workerExecutor.shutdownNow()
        log.info("Blackbox IPC: stopped")
    }

    override fun dispose() { stop() }
}
