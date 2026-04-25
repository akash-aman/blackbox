package cx.akash.blackbox.util

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.application.WriteAction
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** Run [block] under a read action, returning the value. */
fun <T> read(block: () -> T): T = ReadAction.compute<T, RuntimeException> { block() }

/** Run [block] under a write action on the EDT. */
fun <T> write(block: () -> T): T = WriteAction.computeAndWait<T, RuntimeException> { block() }

/**
 * Execute [block] on the EDT and wait for completion.
 * If we are already on the EDT, run synchronously.
 */
fun <T> onEdt(timeoutMs: Long = 10_000, block: () -> T): T {
    val app = ApplicationManager.getApplication()
    if (app.isDispatchThread) return block()
    val future = CompletableFuture<T>()
    app.invokeLater {
        try { future.complete(block()) } catch (t: Throwable) { future.completeExceptionally(t) }
    }
    return future.get(timeoutMs, TimeUnit.MILLISECONDS)
}
