package cx.akash.blackbox.tools.impl

import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.google.gson.JsonObject
import cx.akash.blackbox.util.Json
import cx.akash.blackbox.util.Json.int
import cx.akash.blackbox.util.Json.str
import cx.akash.blackbox.util.onEdt
import cx.akash.blackbox.util.read

object EditorImpl {

    fun openFile(project: Project, args: JsonObject): String {
        val path = args.str("file") ?: return "Error: file path is required"
        val line = args.int("line")
        val vFile = LocalFileSystem.getInstance().refreshAndFindFileByPath(path)
            ?: return "Error opening file: not found ($path)"
        onEdt {
            val descriptor = if (line != null && line > 0)
                OpenFileDescriptor(project, vFile, line - 1, 0)
            else OpenFileDescriptor(project, vFile)
            descriptor.navigate(true)
        }
        return "Opened $path" + (line?.let { ":$it" } ?: "")
    }

    fun getOpenFiles(project: Project): String {
        val list = read {
            val mgr = FileEditorManager.getInstance(project)
            val active = mgr.selectedEditor?.file
            mgr.openFiles.map { f ->
                mapOf(
                    "file" to f.path,
                    "active" to (f == active),
                    "dirty" to com.intellij.openapi.fileEditor.FileDocumentManager.getInstance()
                        .getCachedDocument(f)?.let {
                            com.intellij.openapi.fileEditor.FileDocumentManager.getInstance().isDocumentUnsaved(it)
                        }.let { it == true },
                )
            }
        }
        return Json.prettyStringify(list)
    }
}
