package cx.akash.blackbox.util

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonElement
import com.google.gson.JsonObject

/**
 * Thin Gson wrapper. Gson ships with the IntelliJ Platform — no extra dependency.
 */
object Json {
    val gson: Gson = GsonBuilder().disableHtmlEscaping().create()
    val pretty: Gson = GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create()

    fun parse(raw: String): JsonObject =
        gson.fromJson(raw, JsonObject::class.java) ?: JsonObject()

    fun stringify(value: Any?): String = gson.toJson(value)
    fun prettyStringify(value: Any?): String = pretty.toJson(value)

    fun JsonObject.str(key: String): String? =
        get(key)?.takeUnless { it.isJsonNull }?.asString

    fun JsonObject.int(key: String): Int? =
        get(key)?.takeUnless { it.isJsonNull }?.asInt

    fun JsonObject.long(key: String): Long? =
        get(key)?.takeUnless { it.isJsonNull }?.asLong

    fun JsonObject.obj(key: String): JsonObject? =
        get(key)?.takeIf { it.isJsonObject }?.asJsonObject

    fun JsonObject.arr(key: String): List<JsonElement> =
        get(key)?.takeIf { it.isJsonArray }?.asJsonArray?.toList() ?: emptyList()
}
