package cx.akash.blackbox.tools.impl

import com.intellij.codeInsight.daemon.impl.DaemonCodeAnalyzerImpl
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.search.FilenameIndex
import com.intellij.psi.search.GlobalSearchScope
import com.google.gson.JsonObject
import cx.akash.blackbox.util.Json
import cx.akash.blackbox.util.Json.int
import cx.akash.blackbox.util.Json.str
import cx.akash.blackbox.util.read
import java.nio.file.FileSystems
import java.nio.file.Paths

object WorkspaceImpl {

    fun findFile(project: Project, args: JsonObject): String {
        val pattern = args.str("pattern") ?: return "Error: glob pattern is required"
        val maxResults = (args.int("maxResults") ?: 20).coerceAtLeast(1)

        val matcher = FileSystems.getDefault().getPathMatcher("glob:$pattern")
        val results = mutableListOf<String>()
        val base = project.basePath?.let { Paths.get(it) }

        read {
            val scope = GlobalSearchScope.projectScope(project)
            // Iterate every file name; match the relative path against the glob.
            FilenameIndex.processAllFileNames({ name ->
                if (results.size >= maxResults) return@processAllFileNames false
                FilenameIndex.getVirtualFilesByName(name, scope).forEach { vFile ->
                    if (results.size >= maxResults) return@forEach
                    if (vFile.path.contains("/node_modules/")) return@forEach
                    val rel = base?.let { runCatching { it.relativize(Paths.get(vFile.path)) }.getOrNull() }
                        ?: Paths.get(vFile.path)
                    if (matcher.matches(rel)) results += vFile.path
                }
                true
            }, scope, null)
        }
        return Json.prettyStringify(results)
    }

    fun getDiagnostics(project: Project, args: JsonObject): String {
        val filterFile = args.str("file")
        val severityFilter = args.str("severity") // "error" | "warning"
        val files: List<VirtualFile> = read {
            if (filterFile != null) {
                listOfNotNull(LocalFileSystem.getInstance().refreshAndFindFileByPath(filterFile))
            } else {
                FileEditorManagerLike.openFiles(project)
            }
        }
        val results = read {
            files.mapNotNull { vFile ->
                val doc = FileDocumentManager.getInstance().getDocument(vFile) ?: return@mapNotNull null
                val highlights = DaemonCodeAnalyzerImpl.getHighlights(doc, HighlightSeverity.WARNING, project)
                val issues = highlights
                    .filter { hi ->
                        when (severityFilter) {
                            "error" -> hi.severity.myVal >= HighlightSeverity.ERROR.myVal
                            "warning" -> hi.severity.myVal >= HighlightSeverity.WARNING.myVal
                            else -> true
                        }
                    }
                    .map { hi ->
                        val lineNum = doc.getLineNumber(hi.startOffset) + 1
                        mapOf(
                            "line" to lineNum,
                            "severity" to when {
                                hi.severity.myVal >= HighlightSeverity.ERROR.myVal -> "error"
                                hi.severity.myVal >= HighlightSeverity.WARNING.myVal -> "warning"
                                else -> "info"
                            },
                            "message" to (hi.description ?: ""),
                            "source" to hi.inspectionToolId,
                        )
                    }
                if (issues.isEmpty()) null else mapOf("file" to vFile.path, "issues" to issues)
            }
        }
        return if (results.isEmpty()) "No diagnostics found" else Json.prettyStringify(results)
    }
}

/** Tiny indirection so [WorkspaceImpl] doesn't pull a UI dependency for the no-file branch. */
private object FileEditorManagerLike {
    fun openFiles(project: Project): List<VirtualFile> =
        com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).openFiles.toList()
}
