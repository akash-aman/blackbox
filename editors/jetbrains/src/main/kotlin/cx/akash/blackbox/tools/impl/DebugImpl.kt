package cx.akash.blackbox.tools.impl

import com.intellij.execution.ProgramRunnerUtil
import com.intellij.execution.RunManager
import com.intellij.execution.executors.DefaultDebugExecutor
import com.intellij.execution.runners.ExecutionEnvironmentBuilder
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.xdebugger.XDebuggerManager
import com.intellij.xdebugger.XDebuggerUtil
import com.intellij.xdebugger.breakpoints.XBreakpointManager
import com.intellij.xdebugger.breakpoints.XLineBreakpoint
import com.intellij.xdebugger.breakpoints.XLineBreakpointType
import com.intellij.xdebugger.evaluation.XDebuggerEvaluator
import com.intellij.xdebugger.frame.XCompositeNode
import com.intellij.xdebugger.frame.XStackFrame
import com.intellij.xdebugger.frame.XValue
import com.intellij.xdebugger.frame.XValueChildrenList
import com.intellij.xdebugger.frame.XValueNode
import com.intellij.xdebugger.frame.XValuePlace
import com.intellij.xdebugger.frame.presentation.XValuePresentation
import com.google.gson.JsonObject
import cx.akash.blackbox.util.Json
import cx.akash.blackbox.util.Json.arr
import cx.akash.blackbox.util.Json.int
import cx.akash.blackbox.util.Json.obj
import cx.akash.blackbox.util.Json.str
import cx.akash.blackbox.util.onEdt
import cx.akash.blackbox.util.read
import cx.akash.blackbox.util.write
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlin.math.min

/**
 * Shared debug-tool implementation. Mirrors editors/vscode/src/tools/impl/debug.ts
 * line-by-line in behavior; output strings match VS Code wherever practical.
 *
 * IntelliJ exposes debugging through XDebugger (not raw DAP), so calls translate to:
 *   • XBreakpointManager + XLineBreakpointType for breakpoints
 *   • XDebuggerManager.currentSession for run state
 *   • XDebuggerEvaluator for `evaluate` / `inspect` / `watch`
 *   • XStackFrame.computeChildren for `get_variables`
 */
object DebugImpl {

    /** Per-project watch list. Persists across step/continue within the IDE session. */
    private val watchExpressions: MutableMap<Project, MutableSet<String>> = mutableMapOf()

    // ───────────────────────────── Breakpoints ─────────────────────────────

    fun setBreakpoint(project: Project, args: JsonObject): String {
        data class Spec(val file: String, val line: Int, val condition: String?, val log: String?)
        val specs: List<Spec> = run {
            val batch = args.arr("breakpoints")
            if (batch.isNotEmpty()) batch.mapNotNull { el ->
                val o = el as? JsonObject ?: return@mapNotNull null
                val f = o.str("file") ?: return@mapNotNull null
                val l = o.int("line") ?: return@mapNotNull null
                Spec(f, l, o.str("condition"), o.str("logMessage"))
            } else {
                val f = args.str("file") ?: return "skip: invalid — file and line (>= 1) required"
                val l = args.int("line") ?: return "skip: invalid — file and line (>= 1) required"
                listOf(Spec(f, l, args.str("condition"), args.str("logMessage")))
            }
        }
        val results = mutableListOf<String>()
        for (spec in specs) {
            if (spec.line < 1) {
                results += "skip: invalid — file and line (>= 1) required"
                continue
            }
            val vFile = LocalFileSystem.getInstance().refreshAndFindFileByPath(spec.file)
            if (vFile == null) {
                results += "skip: file not found: ${spec.file}"
                continue
            }
            try {
                write {
                    val mgr = XDebuggerManager.getInstance(project).breakpointManager
                    val type = pickLineBreakpointType(project, vFile, spec.line - 1, mgr)
                        ?: throw IllegalStateException("no breakpoint type registered for ${vFile.name}")
                    @Suppress("UNCHECKED_CAST")
                    val typed = type as XLineBreakpointType<Any?>
                    val existing = mgr.findBreakpointAtLine(typed, vFile, spec.line - 1)
                    val bp: XLineBreakpoint<*> = existing
                        ?: mgr.addLineBreakpoint(typed, vFile.url, spec.line - 1, null)
                    if (spec.condition != null) bp.conditionExpression = XDebuggerUtil.getInstance()
                        .createExpression(spec.condition, null, null, com.intellij.xdebugger.evaluation.EvaluationMode.EXPRESSION)
                    if (spec.log != null) {
                        bp.logExpression = spec.log
                        bp.isLogMessage = true
                    }
                }
                results += "ok: ${spec.file}:${spec.line}" +
                    (spec.condition?.let { " (if: $it)" } ?: "") +
                    (spec.log?.let { " (log: $it)" } ?: "")
            } catch (t: Throwable) {
                results += "error: ${spec.file}:${spec.line}: ${t.message}"
            }
        }
        return results.joinToString("\n")
    }

    fun removeBreakpoint(project: Project, args: JsonObject): String {
        data class Loc(val file: String, val line: Int)
        val specs: List<Loc> = run {
            val batch = args.arr("breakpoints")
            if (batch.isNotEmpty()) batch.mapNotNull { el ->
                val o = el as? JsonObject ?: return@mapNotNull null
                val f = o.str("file") ?: return@mapNotNull null
                val l = o.int("line") ?: return@mapNotNull null
                Loc(f, l)
            } else {
                val f = args.str("file") ?: return "skip: invalid — file and line required"
                val l = args.int("line") ?: return "skip: invalid — file and line required"
                listOf(Loc(f, l))
            }
        }
        val results = mutableListOf<String>()
        write {
            val mgr = XDebuggerManager.getInstance(project).breakpointManager
            for (spec in specs) {
                val matches = mgr.allBreakpoints
                    .filterIsInstance<XLineBreakpoint<*>>()
                    .filter { it.fileUrl.endsWith(spec.file) && it.line == spec.line - 1 }
                if (matches.isEmpty()) {
                    results += "skip: no breakpoint at ${spec.file}:${spec.line}"
                } else {
                    matches.forEach { mgr.removeBreakpoint(it) }
                    results += "ok: removed ${spec.file}:${spec.line}"
                }
            }
        }
        return results.joinToString("\n")
    }

    fun removeAllBreakpoints(project: Project): String {
        var count = 0
        write {
            val mgr = XDebuggerManager.getInstance(project).breakpointManager
            val all = mgr.allBreakpoints.toList()
            count = all.size
            all.forEach { mgr.removeBreakpoint(it) }
        }
        return if (count == 0) "No breakpoints to remove" else "Removed all $count breakpoint(s)"
    }

    fun listBreakpoints(project: Project): String {
        val list = read {
            XDebuggerManager.getInstance(project).breakpointManager.allBreakpoints.map { bp ->
                if (bp is XLineBreakpoint<*>) {
                    mapOf(
                        "type" to "source",
                        "file" to bp.presentableFilePath,
                        "line" to bp.line + 1,
                        "enabled" to bp.isEnabled,
                        "condition" to bp.conditionExpression?.expression,
                        "logMessage" to bp.logExpression,
                    )
                } else mapOf("type" to "other", "enabled" to bp.isEnabled)
            }
        }
        return Json.prettyStringify(list)
    }

    private fun pickLineBreakpointType(
        project: Project, file: VirtualFile, line: Int, mgr: XBreakpointManager,
    ): XLineBreakpointType<*>? {
        val types = XDebuggerUtil.getInstance().lineBreakpointTypes
        return types.firstOrNull { it.canPutAt(file, line, project) }
            ?: types.firstOrNull()
    }

    // ──────────────────────────── Session control ──────────────────────────

    fun startDebug(project: Project, args: JsonObject): String {
        val configName = args.str("name")
        val rm = RunManager.getInstance(project)
        val executor = DefaultDebugExecutor.getDebugExecutorInstance()

        val settings = if (configName != null) rm.findConfigurationByName(configName) else rm.selectedConfiguration
        if (settings == null) {
            return buildString {
                append("Error: no run configuration found")
                if (configName != null) append(" with name '$configName'")
                append(". Define one in Run > Edit Configurations and pass its name in `name`. ")
                append("JetBrains debug sessions are launched from typed run configurations rather than ")
                append("free-form DAP arguments — see docs/implementation-plan.md §3.5.")
            }
        }
        val started = onEdt(timeoutMs = 10_000) {
            try {
                val env = ExecutionEnvironmentBuilder.create(executor, settings).build()
                ProgramRunnerUtil.executeConfiguration(env, false, true)
                true
            } catch (t: Throwable) { false }
        }
        return if (started) "Debug session \"${settings.name}\" started"
        else "Error: failed to start debug session \"${settings.name}\""
    }

    fun stopDebug(project: Project): String {
        val session = XDebuggerManager.getInstance(project).currentSession
            ?: return "No active debug session"
        val name = session.sessionName
        onEdt { session.stop() }
        return "Debug session \"$name\" stopped"
    }

    fun restartDebug(project: Project): String {
        val session = XDebuggerManager.getInstance(project).currentSession
            ?: return "Error: no active debug session"
        // Easiest portable restart: stop then re-execute the same configuration.
        val rm = RunManager.getInstance(project)
        val settings = rm.findConfigurationByName(session.sessionName) ?: rm.selectedConfiguration
        onEdt { session.stop() }
        if (settings == null) return "Debug session \"${session.sessionName}\" stopped (cannot find configuration to restart)"
        val ok = onEdt {
            try {
                val env = ExecutionEnvironmentBuilder.create(DefaultDebugExecutor.getDebugExecutorInstance(), settings).build()
                ProgramRunnerUtil.executeConfiguration(env, false, true); true
            } catch (_: Throwable) { false }
        }
        return if (ok) "Debug session \"${session.sessionName}\" restarted" else "Error: failed to restart"
    }

    // ─────────────────────────── Execution control ─────────────────────────

    fun continueDebug(project: Project): String = withSession(project) { s ->
        onEdt { s.resume() }; "Resumed execution"
    }

    fun pauseDebug(project: Project): String = withSession(project) { s ->
        onEdt { s.pause() }; "Paused execution"
    }

    fun stepOver(project: Project): String = withSession(project) { s ->
        onEdt { s.stepOver(false) }; "Stepped over to next line"
    }

    fun stepInto(project: Project): String = withSession(project) { s ->
        onEdt { s.stepInto() }; "Stepped into function"
    }

    fun stepOut(project: Project): String = withSession(project) { s ->
        onEdt { s.stepOut() }; "Stepped out of function"
    }

    // ───────────────────────────── Inspection ──────────────────────────────

    fun evaluate(project: Project, args: JsonObject): String {
        val expr = args.str("expression") ?: return "Error: expression is required"
        val session = XDebuggerManager.getInstance(project).currentSession
            ?: return "Error: no active debug session"
        val evaluator = session.currentStackFrame?.evaluator
            ?: return "Error: no stack frames — is the debugger stopped at a breakpoint?"
        val result = blockingEvaluate(evaluator, expr)
        return Json.prettyStringify(mapOf(
            "expression" to expr,
            "result" to result.first,
            "type" to result.second,
        ))
    }

    fun getVariables(project: Project, args: JsonObject): String {
        val filter = args.str("filter")?.lowercase()
        val session = XDebuggerManager.getInstance(project).currentSession
            ?: return "Error: no active debug session"
        val frame: XStackFrame = session.currentStackFrame
            ?: return "No stack frames — is the debugger stopped at a breakpoint?"
        val children = collectChildren(frame, maxItems = 200)
        val mapped = children
            .let { c -> if (filter == null) c else c.filter { it.name.lowercase().contains(filter) } }
            .map { mapOf("name" to it.name, "value" to it.value, "type" to it.type) }
        return Json.prettyStringify(mapOf("locals" to mapped))
    }

    fun getStackTrace(project: Project): String {
        val session = XDebuggerManager.getInstance(project).currentSession
            ?: return "Error: no active debug session"
        val thread = session.suspendContext?.activeExecutionStack ?: return "No threads"
        val frames = blockingComputeFrames(thread, levels = 20).mapIndexed { i, f ->
            val pos = f.sourcePosition
            mapOf(
                "id" to i,
                "name" to (f.equalityObject?.toString() ?: f.toString()),
                "file" to (pos?.file?.path ?: "(unknown)"),
                "line" to ((pos?.line ?: -1) + 1),
            )
        }
        return Json.prettyStringify(frames)
    }

    fun getLaunchConfigs(project: Project): String {
        val rm = RunManager.getInstance(project)
        val items = read {
            rm.allSettings.map { s ->
                mapOf(
                    "name" to s.name,
                    "type" to s.type.id,
                    "factory" to s.factory?.name,
                    "isTemporary" to s.isTemporary,
                )
            }
        }
        // Also expose .vscode/launch.json for parity with the VS Code port.
        val vscodeConfigs = mutableListOf<Map<String, Any>>()
        val base = project.basePath
        if (base != null) {
            val launch = Path.of(base, ".vscode", "launch.json")
            if (Files.exists(launch)) {
                try {
                    val raw = Files.readString(launch)
                        .replace(Regex("//.*$", RegexOption.MULTILINE), "")
                        .replace(Regex("/\\*[\\s\\S]*?\\*/"), "")
                    val parsed = Json.parse(raw)
                    val configurations = parsed.arr("configurations").map { it.toString() }
                    vscodeConfigs += mapOf("folder" to base, "configurations" to configurations)
                } catch (_: Throwable) { /* ignore */ }
            }
        }
        return Json.prettyStringify(mapOf("runConfigurations" to items, "vscodeLaunchJson" to vscodeConfigs))
    }

    fun inspect(project: Project, args: JsonObject): String {
        val variable = args.str("variable") ?: return "Error: variable expression is required"
        val depth = (args.int("depth") ?: 2).coerceIn(1, 5)
        val maxItems = (args.int("maxItems") ?: 50).coerceAtMost(200)
        val session = XDebuggerManager.getInstance(project).currentSession
            ?: return "Error: no active debug session"
        val evaluator = session.currentStackFrame?.evaluator
            ?: return "Error: no stack frames — is the debugger stopped at a breakpoint?"
        return try {
            val xValue = blockingEvaluateXValue(evaluator, variable)
            val tree = expand(xValue, 0, depth, maxItems)
            Json.prettyStringify(mapOf("variable" to variable, "value" to tree))
        } catch (t: Throwable) {
            "Error inspecting \"$variable\": ${t.message}"
        }
    }

    fun watch(project: Project, args: JsonObject): String {
        val action = args.str("action") ?: return "Error: action must be add, remove, list, or clear"
        val exprs = args.arr("expressions").mapNotNull { (it as? com.google.gson.JsonPrimitive)?.asString }
        val watches = watchExpressions.getOrPut(project) { mutableSetOf() }
        return when (action) {
            "add" -> {
                if (exprs.isEmpty()) return "Error: expressions array required for add"
                watches.addAll(exprs)
                "Watching ${exprs.size} expression(s). Total watches: ${watches.size}\n${watches.joinToString(", ")}"
            }
            "remove" -> {
                if (exprs.isEmpty()) return "Error: expressions array required for remove"
                watches.removeAll(exprs.toSet())
                "Removed ${exprs.size}. Remaining watches: ${watches.size}" +
                    if (watches.isEmpty()) "" else "\n${watches.joinToString(", ")}"
            }
            "clear" -> {
                val n = watches.size; watches.clear(); "Cleared all $n watch expression(s)"
            }
            "list" -> {
                if (watches.isEmpty()) return "No watch expressions set. Use action=\"add\" first."
                val session = XDebuggerManager.getInstance(project).currentSession
                    ?: return "Watch expressions (${watches.size}): ${watches.joinToString(", ")}\n(No active debug session — values not available)"
                val evaluator = session.currentStackFrame?.evaluator
                    ?: return "Watch expressions set but no stack frame — is the debugger stopped?"
                val results = mutableMapOf<String, Any?>()
                for (e in watches) {
                    results[e] = try { blockingEvaluate(evaluator, e).first }
                    catch (t: Throwable) { "<error: ${t.message}>" }
                }
                Json.prettyStringify(results)
            }
            else -> "Error: action must be add, remove, list, or clear"
        }
    }

    // ───────────────────────────── Helpers ─────────────────────────────────

    private inline fun withSession(project: Project, block: (com.intellij.xdebugger.XDebugSession) -> String): String {
        val s = XDebuggerManager.getInstance(project).currentSession ?: return "Error: no active debug session"
        return block(s)
    }

    private fun blockingEvaluate(evaluator: XDebuggerEvaluator, expression: String, timeoutMs: Long = 10_000): Pair<String?, String?> {
        val future = CompletableFuture<Pair<String?, String?>>()
        evaluator.evaluate(expression, object : XDebuggerEvaluator.XEvaluationCallback {
            override fun evaluated(result: XValue) {
                val rendered = renderValue(result)
                future.complete(rendered to extractType(result))
            }
            override fun errorOccurred(errorMessage: String) {
                future.completeExceptionally(RuntimeException(errorMessage))
            }
        }, null)
        return future.get(timeoutMs, TimeUnit.MILLISECONDS)
    }

    private fun blockingEvaluateXValue(evaluator: XDebuggerEvaluator, expression: String, timeoutMs: Long = 10_000): XValue {
        val future = CompletableFuture<XValue>()
        evaluator.evaluate(expression, object : XDebuggerEvaluator.XEvaluationCallback {
            override fun evaluated(result: XValue) { future.complete(result) }
            override fun errorOccurred(errorMessage: String) { future.completeExceptionally(RuntimeException(errorMessage)) }
        }, null)
        return future.get(timeoutMs, TimeUnit.MILLISECONDS)
    }

    private data class ChildRow(val name: String, val value: String?, val type: String?)

    private fun collectChildren(frame: XStackFrame, maxItems: Int, timeoutMs: Long = 10_000): List<ChildRow> {
        val rows = mutableListOf<ChildRow>()
        val done = CompletableFuture<Unit>()
        val node = object : XCompositeNode {
            override fun addChildren(children: XValueChildrenList, last: Boolean) {
                for (i in 0 until min(children.size(), maxItems - rows.size)) {
                    val name = children.getName(i)
                    val v = children.getValue(i)
                    rows += ChildRow(name, renderValue(v), extractType(v))
                    if (rows.size >= maxItems) break
                }
                if (last) done.complete(Unit)
            }
            override fun tooManyChildren(remaining: Int) { done.complete(Unit) }
            override fun setAlreadySorted(alreadySorted: Boolean) {}
            override fun setErrorMessage(errorMessage: String) { done.completeExceptionally(RuntimeException(errorMessage)) }
            override fun setErrorMessage(errorMessage: String, link: com.intellij.xdebugger.frame.XDebuggerTreeNodeHyperlink?) { done.completeExceptionally(RuntimeException(errorMessage)) }
            override fun setMessage(message: String, icon: javax.swing.Icon?, attributes: com.intellij.ui.SimpleTextAttributes, link: com.intellij.xdebugger.frame.XDebuggerTreeNodeHyperlink?) {}
        }
        frame.computeChildren(node)
        try { done.get(timeoutMs, TimeUnit.MILLISECONDS) } catch (_: Throwable) { /* return what we have */ }
        return rows
    }

    private fun blockingComputeFrames(stack: com.intellij.xdebugger.frame.XExecutionStack, levels: Int, timeoutMs: Long = 10_000): List<XStackFrame> {
        val frames = mutableListOf<XStackFrame>()
        val done = CompletableFuture<Unit>()
        stack.computeStackFrames(0, object : com.intellij.xdebugger.frame.XExecutionStack.XStackFrameContainer {
            override fun addStackFrames(stackFrames: MutableList<out XStackFrame>, last: Boolean) {
                stackFrames.take(levels - frames.size).let { frames.addAll(it) }
                if (last || frames.size >= levels) done.complete(Unit)
            }
            override fun errorOccurred(errorMessage: String) { done.completeExceptionally(RuntimeException(errorMessage)) }
        })
        try { done.get(timeoutMs, TimeUnit.MILLISECONDS) } catch (_: Throwable) { /* return what we have */ }
        return frames
    }

    private fun renderValue(v: XValue): String? {
        val sb = StringBuilder()
        val done = CompletableFuture<Unit>()
        v.computePresentation(object : XValueNode {
            override fun setPresentation(icon: javax.swing.Icon?, type: String?, value: String, hasChildren: Boolean) {
                sb.append(value); done.complete(Unit)
            }
            override fun setPresentation(icon: javax.swing.Icon?, presentation: XValuePresentation, hasChildren: Boolean) {
                presentation.renderValue(object : XValuePresentation.XValueTextRenderer {
                    override fun renderValue(value: String) { sb.append(value) }
                    override fun renderStringValue(value: String) { sb.append('"').append(value).append('"') }
                    override fun renderNumericValue(value: String) { sb.append(value) }
                    override fun renderKeywordValue(value: String) { sb.append(value) }
                    override fun renderValue(value: String, key: com.intellij.openapi.editor.colors.TextAttributesKey) { sb.append(value) }
                    override fun renderStringValue(value: String, additionalSpecialCharsToHighlight: String?, maxLength: Int) { sb.append('"').append(value).append('"') }
                    override fun renderComment(comment: String) {}
                    override fun renderSpecialSymbol(symbol: String) { sb.append(symbol) }
                    override fun renderError(error: String) { sb.append("<error: ").append(error).append(">") }
                })
                done.complete(Unit)
            }
            override fun setFullValueEvaluator(fullValueEvaluator: com.intellij.xdebugger.frame.XFullValueEvaluator) {}
            override fun isObsolete(): Boolean = false
        }, XValuePlace.TREE)
        return try { done.get(2_000, TimeUnit.MILLISECONDS); sb.toString() } catch (_: Throwable) { sb.toString().ifEmpty { null } }
    }

    private fun extractType(v: XValue): String? {
        var captured: String? = null
        val done = CompletableFuture<Unit>()
        v.computePresentation(object : XValueNode {
            override fun setPresentation(icon: javax.swing.Icon?, type: String?, value: String, hasChildren: Boolean) { captured = type; done.complete(Unit) }
            override fun setPresentation(icon: javax.swing.Icon?, presentation: XValuePresentation, hasChildren: Boolean) { captured = presentation.type; done.complete(Unit) }
            override fun setFullValueEvaluator(fullValueEvaluator: com.intellij.xdebugger.frame.XFullValueEvaluator) {}
            override fun isObsolete(): Boolean = false
        }, XValuePlace.TREE)
        try { done.get(2_000, TimeUnit.MILLISECONDS) } catch (_: Throwable) { /* ignore */ }
        return captured
    }

    private fun expand(value: XValue, depth: Int, maxDepth: Int, maxItems: Int): Any? {
        val rendered = renderValue(value)
        if (depth >= maxDepth) return rendered ?: "..."
        val children = mutableMapOf<String, Any?>()
        val done = CompletableFuture<Unit>()
        val node = object : XCompositeNode {
            override fun addChildren(list: XValueChildrenList, last: Boolean) {
                for (i in 0 until min(list.size(), maxItems)) {
                    val name = list.getName(i)
                    val child = list.getValue(i)
                    children[name] = expand(child, depth + 1, maxDepth, maxItems)
                }
                if (list.size() > maxItems) children["..."] = "(${list.size() - maxItems} more items)"
                if (last) done.complete(Unit)
            }
            override fun tooManyChildren(remaining: Int) { done.complete(Unit) }
            override fun setAlreadySorted(alreadySorted: Boolean) {}
            override fun setErrorMessage(errorMessage: String) { done.complete(Unit) }
            override fun setErrorMessage(errorMessage: String, link: com.intellij.xdebugger.frame.XDebuggerTreeNodeHyperlink?) { done.complete(Unit) }
            override fun setMessage(message: String, icon: javax.swing.Icon?, attributes: com.intellij.ui.SimpleTextAttributes, link: com.intellij.xdebugger.frame.XDebuggerTreeNodeHyperlink?) {}
        }
        value.computeChildren(node)
        try { done.get(5_000, TimeUnit.MILLISECONDS) } catch (_: Throwable) { /* return what we have */ }
        return if (children.isEmpty()) rendered else children
    }
}
