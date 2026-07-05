package com.readlater.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Article metadata (plus body when fetched individually) as returned by the server. */
data class RemoteArticle(
    val id: String,
    val url: String,
    val title: String,
    val byline: String?,
    val siteName: String?,
    val excerpt: String?,
    val savedAt: Long,
    val updatedAt: Long,
    val archived: Boolean,
    val favorite: Boolean,
    val readParagraph: Int,
    val html: String?
)

/** Highlight as returned by the server. */
data class RemoteHighlight(
    val id: String,
    val articleId: String,
    val text: String,
    val note: String?,
    val paragraphIndex: Int,
    val createdAt: Long
)

/**
 * Thin OkHttp wrapper around the ReadLater server API.
 * All methods are suspend and throw [IOException] with a readable message on failure.
 */
class ApiClient(private val settings: Settings) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    private fun builder(path: String): Request.Builder {
        val base = settings.serverUrl
        if (base.isBlank()) {
            throw IOException("Server URL is not configured. Open Settings first.")
        }
        return Request.Builder()
            .url(base + path)
            .header("Authorization", "Bearer ${settings.token}")
    }

    private suspend fun execute(request: Request): String = withContext(Dispatchers.IO) {
        val response = try {
            client.newCall(request).execute()
        } catch (e: IOException) {
            throw IOException("Network error: ${e.message}", e)
        }
        response.use { resp ->
            val body = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                val detail = body.take(200).ifBlank { resp.message }
                throw IOException("Server error ${resp.code}: $detail")
            }
            body
        }
    }

    /** GET /api/health */
    suspend fun health(): Boolean {
        val body = execute(builder("/api/health").get().build())
        return JSONObject(body).optBoolean("ok", false)
    }

    /** GET /api/articles?includeArchived=1 — metadata only, no html. */
    suspend fun listArticles(): List<RemoteArticle> {
        val body = execute(builder("/api/articles?includeArchived=1").get().build())
        val arr = JSONObject(body).getJSONArray("articles")
        return (0 until arr.length()).map { parseArticle(arr.getJSONObject(it)) }
    }

    /** GET /api/articles/{id} — full article including html. */
    suspend fun getArticle(id: String): RemoteArticle {
        val body = execute(builder("/api/articles/$id").get().build())
        return parseArticle(JSONObject(body))
    }

    /** PATCH /api/articles/{id} with any subset of mutable metadata fields. */
    suspend fun patchArticle(
        id: String,
        archived: Boolean? = null,
        favorite: Boolean? = null,
        readParagraph: Int? = null
    ): RemoteArticle {
        val json = JSONObject()
        archived?.let { json.put("archived", it) }
        favorite?.let { json.put("favorite", it) }
        readParagraph?.let { json.put("readParagraph", it) }
        val body = execute(
            builder("/api/articles/$id")
                .method("PATCH", json.toString().toRequestBody(jsonMediaType))
                .build()
        )
        return parseArticle(JSONObject(body))
    }

    /** DELETE /api/articles/{id} */
    suspend fun deleteArticle(id: String) {
        execute(builder("/api/articles/$id").delete().build())
    }

    /** GET /api/articles/{id}/highlights */
    suspend fun getHighlights(articleId: String): List<RemoteHighlight> {
        val body = execute(builder("/api/articles/$articleId/highlights").get().build())
        val arr = JSONObject(body).getJSONArray("highlights")
        return (0 until arr.length()).map { parseHighlight(arr.getJSONObject(it)) }
    }

    /** POST /api/articles/{id}/highlights — server dedupes by clientId. */
    suspend fun postHighlight(highlight: HighlightEntity): RemoteHighlight {
        val json = JSONObject().apply {
            put("text", highlight.text)
            if (highlight.note != null) put("note", highlight.note)
            put("paragraphIndex", highlight.paragraphIndex)
            put("createdAt", highlight.createdAt)
            put("clientId", highlight.clientId)
        }
        val body = execute(
            builder("/api/articles/${highlight.articleId}/highlights")
                .post(json.toString().toRequestBody(jsonMediaType))
                .build()
        )
        return parseHighlight(JSONObject(body))
    }

    /** DELETE /api/highlights/{id} */
    suspend fun deleteHighlight(serverId: String) {
        execute(builder("/api/highlights/$serverId").delete().build())
    }

    private fun parseArticle(o: JSONObject): RemoteArticle = RemoteArticle(
        id = o.getString("id"),
        url = o.optString("url"),
        title = o.optString("title"),
        byline = o.stringOrNull("byline"),
        siteName = o.stringOrNull("siteName"),
        excerpt = o.stringOrNull("excerpt"),
        savedAt = o.optLong("savedAt"),
        updatedAt = o.optLong("updatedAt"),
        archived = o.optBoolean("archived", false),
        favorite = o.optBoolean("favorite", false),
        readParagraph = o.optInt("readParagraph", 0),
        html = o.stringOrNull("html")
    )

    private fun parseHighlight(o: JSONObject): RemoteHighlight = RemoteHighlight(
        id = o.getString("id"),
        articleId = o.optString("articleId"),
        text = o.optString("text"),
        note = o.stringOrNull("note"),
        paragraphIndex = o.optInt("paragraphIndex", 0),
        createdAt = o.optLong("createdAt")
    )

    private fun JSONObject.stringOrNull(key: String): String? =
        if (has(key) && !isNull(key)) getString(key) else null
}
