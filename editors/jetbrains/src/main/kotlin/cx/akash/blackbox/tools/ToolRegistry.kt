package cx.akash.blackbox.tools

import com.intellij.openapi.project.Project
import com.google.gson.JsonObject
import cx.akash.blackbox.tools.impl.DebugImpl
import cx.akash.blackbox.tools.impl.EditorImpl
import cx.akash.blackbox.tools.impl.WorkspaceImpl

/**
 * Single source of truth for tool dispatch — used by both the IPC server
 * (external MCP clients) and the JetBrains MCP Server plugin EP (native AI Assistant).
 *
 * Tool names match editors/vscode/src/ipc/handlers.ts and schema/tools.json.
 */
object ToolRegistry {

    private val handlers: Map<String, (Project, JsonObject) -> String> = mapOf(
        // Breakpoints
        "debug_set_breakpoint" to DebugImpl::setBreakpoint,
        "debug_remove_breakpoint" to DebugImpl::removeBreakpoint,
        "debug_remove_all_breakpoints" to { p, _ -> DebugImpl.removeAllBreakpoints(p) },
        "debug_list_breakpoints" to { p, _ -> DebugImpl.listBreakpoints(p) },

        // Session
        "debug_start" to DebugImpl::startDebug,
        "debug_stop" to { p, _ -> DebugImpl.stopDebug(p) },
        "debug_restart" to { p, _ -> DebugImpl.restartDebug(p) },

        // Execution
        "debug_continue" to { p, _ -> DebugImpl.continueDebug(p) },
        "debug_pause" to { p, _ -> DebugImpl.pauseDebug(p) },
        "debug_step_over" to { p, _ -> DebugImpl.stepOver(p) },
        "debug_step_into" to { p, _ -> DebugImpl.stepInto(p) },
        "debug_step_out" to { p, _ -> DebugImpl.stepOut(p) },

        // Inspection
        "debug_evaluate" to DebugImpl::evaluate,
        "debug_get_variables" to DebugImpl::getVariables,
        "debug_get_stack_trace" to { p, _ -> DebugImpl.getStackTrace(p) },
        "debug_get_launch_configs" to { p, _ -> DebugImpl.getLaunchConfigs(p) },
        "debug_inspect" to DebugImpl::inspect,
        "debug_watch" to DebugImpl::watch,

        // Editor
        "editor_open_file" to EditorImpl::openFile,
        "editor_get_open_files" to { p, _ -> EditorImpl.getOpenFiles(p) },

        // Workspace
        "workspace_find_file" to WorkspaceImpl::findFile,
        "workspace_get_diagnostics" to WorkspaceImpl::getDiagnostics,
    )

    fun has(tool: String): Boolean = handlers.containsKey(tool)

    fun invoke(project: Project, tool: String, args: JsonObject): String {
        val handler = handlers[tool] ?: return "Error: unknown tool '$tool'"
        return handler(project, args)
    }

    val toolNames: Set<String> = handlers.keys
}
