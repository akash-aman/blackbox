package cx.akash.blackbox

import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManagerListener
import com.intellij.openapi.startup.ProjectActivity
import cx.akash.blackbox.ipc.IpcServer
import cx.akash.blackbox.ipc.Protocol

/**
 * Starts the per-project IPC server when the project finishes opening.
 *
 * The IpcServer is registered as a project-level service in plugin.xml and is
 * automatically disposed when the project closes (its [IpcServer.dispose]
 * unlinks the socket and shuts down the executors).
 */
class BlackboxStartup : ProjectActivity {
    override suspend fun execute(project: Project) {
        val ipc = project.getService(IpcServer::class.java)
        ipc.start()
        Protocol.log().info("Blackbox: project '${project.name}' ready")
    }
}

/** Belt-and-braces: also stop the IPC server if a project is closed externally. */
class BlackboxAppListener : ProjectManagerListener {
    override fun projectClosing(project: Project) {
        try { project.getService(IpcServer::class.java).stop() } catch (_: Throwable) { /* ignore */ }
    }
}
