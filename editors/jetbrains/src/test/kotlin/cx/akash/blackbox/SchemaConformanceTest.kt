package cx.akash.blackbox

import com.google.gson.JsonObject
import cx.akash.blackbox.tools.ToolRegistry
import cx.akash.blackbox.util.Json
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Paths

/**
 * Schema-conformance: every tool defined in /schema/tools.json must have a
 * handler in [ToolRegistry], and vice versa. Mirrors the equivalent test in
 * the Neovim port (tests/registry_spec.lua).
 */
class SchemaConformanceTest {

    @Test
    fun `every schema tool has a handler`() {
        val schemaPath = locateSchema()
        val schema = Json.parse(Files.readString(schemaPath))
        val toolNames = schema.getAsJsonArray("tools")
            .map { (it as JsonObject).get("name").asString }
            .toSet()

        val missing = toolNames - ToolRegistry.toolNames
        assertTrue("missing handlers for: $missing", missing.isEmpty())
    }

    @Test
    fun `no tool registered outside the schema`() {
        val schemaPath = locateSchema()
        val schema = Json.parse(Files.readString(schemaPath))
        val toolNames = schema.getAsJsonArray("tools")
            .map { (it as JsonObject).get("name").asString }
            .toSet()

        val extra = ToolRegistry.toolNames - toolNames
        assertTrue("registered but not in schema: $extra", extra.isEmpty())
    }

    private fun locateSchema(): java.nio.file.Path {
        // Walk up from the project dir until we find the repo root.
        var dir = Paths.get("").toAbsolutePath()
        repeat(8) {
            val candidate = dir.resolve("schema/tools.json")
            if (Files.exists(candidate)) return candidate
            dir = dir.parent ?: return@repeat
        }
        throw IllegalStateException("Could not locate schema/tools.json from ${Paths.get("").toAbsolutePath()}")
    }
}
