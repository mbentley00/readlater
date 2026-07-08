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
    val ttsParagraph: Int,
    val wordCount: Int,
    val imageUrl: String?,
    val publishedAt: Long?,
    val html: String?
)

/** Saved filter view as returned by the server. */
data class RemoteView(
    val id: String,
    val name: String,
    val q: String,
    val domain: String,
    val highlighted: Boolean,
    val minWords: Int,
    val maxWords: Int,
    val minHighlights: Int,
    val includeArchived: Boolean
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

    /**
     * POST /api/login — exchanges username/password for the account's API token.
     * Standalone (doesn't use stored settings) so it can run before anything is saved.
     */
    suspend fun login(baseUrl: String, username: String, password: String): String {
        val json = JSONObject().put("username", username).put("password", password)
        val request = Request.Builder()
            .url(baseUrl.trim().trimEnd('/') + "/api/login")
            .post(json.toString().toRequestBody(jsonMediaType))
            .build()
        val body = try {
            execute(request)
        } catch (e: IOException) {
            if (e.message?.contains("401") == true) throw IOException("Wrong username or password.")
            throw e
        }
        return JSONObject(body).getString("token")
    }

    /** GET /api/articles?includeArchived=1 — metadata only, no html.
     *  Pass [since] (updatedAt watermark) to fetch only changed articles. */
    suspend fun listArticles(since: Long = 0): List<RemoteArticle> {
        val qs = if (since > 0) "&since=$since" else ""
        val body = execute(builder("/api/articles?includeArchived=1$qs").get().build())
        val arr = JSONObject(body).getJSONArray("articles")
        return (0 until arr.length()).map { parseArticle(arr.getJSONObject(it)) }
    }

    /** GET /api/app-version — metadata of the newest APK uploaded to the server. */
    suspend fun latestAppVersion(): Pair<String, Int>? = try {
        val body = execute(builder("/api/app-version").get().build())
        val o = JSONObject(body)
        (o.stringOrNull("versionName") ?: "?") to o.optInt("versionCode", 0)
    } catch (_: Exception) {
        null
    }

    /** GET /api/views — the user's saved filter views. */
    /** POST /api/views — create a saved view (filter set) and return it. */
    suspend fun createView(name: String, view: RemoteView): RemoteView {
        val filters = JSONObject().apply {
            if (view.q.isNotBlank()) put("q", view.q)
            if (view.domain.isNotBlank()) put("domain", view.domain)
            if (view.highlighted) put("highlighted", true)
            if (view.minWords > 0) put("minWords", view.minWords)
            if (view.maxWords > 0) put("maxWords", view.maxWords)
            if (view.minHighlights > 0) put("minHighlights", view.minHighlights)
            if (view.includeArchived) put("includeArchived", true)
        }
        val json = JSONObject().apply { put("name", name); put("filters", filters) }
        val body = execute(builder("/api/views").post(json.toString().toRequestBody(jsonMediaType)).build())
        val o = JSONObject(body)
        val f = o.optJSONObject("filters") ?: JSONObject()
        return RemoteView(
            id = o.getString("id"), name = o.optString("name"),
            q = f.optString("q"), domain = f.optString("domain"),
            highlighted = f.optBoolean("highlighted", false),
            minWords = f.optInt("minWords", 0), maxWords = f.optInt("maxWords", 0),
            minHighlights = f.optInt("minHighlights", 0),
            includeArchived = f.optBoolean("includeArchived", false)
        )
    }

    /** DELETE /api/views/{id} */
    suspend fun deleteView(id: String) {
        execute(builder("/api/views/$id").delete().build())
    }

    suspend fun listViews(): List<RemoteView> {
        val body = execute(builder("/api/views").get().build())
        val arr = JSONObject(body).getJSONArray("views")
        return (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            val f = o.optJSONObject("filters") ?: JSONObject()
            RemoteView(
                id = o.getString("id"),
                name = o.optString("name"),
                q = f.optString("q"),
                domain = f.optString("domain"),
                highlighted = f.optBoolean("highlighted", false),
                minWords = f.optInt("minWords", 0),
                maxWords = f.optInt("maxWords", 0),
                minHighlights = f.optInt("minHighlights", 0),
                includeArchived = f.optBoolean("includeArchived", false)
            )
        }
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
        readParagraph: Int? = null,
        ttsParagraph: Int? = null
    ): RemoteArticle {
        val json = JSONObject()
        archived?.let { json.put("archived", it) }
        favorite?.let { json.put("favorite", it) }
        readParagraph?.let { json.put("readParagraph", it) }
        ttsParagraph?.let { json.put("ttsParagraph", it) }
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

    /** Status + timing of an article's server-synthesized audio. */
    data class AudioMeta(
        val ready: Boolean,
        val enabled: Boolean,
        val durationMs: Int,
        val sampleRate: Int,
        val format: String, // "opus" or "wav"
        val offsetsMs: IntArray
    )

    /** GET /api/articles/{id}/audio — status + per-paragraph offsets. Also asks
     *  the server to start generating if it isn't cached yet. */
    suspend fun audioMeta(articleId: String): AudioMeta? = try {
        val o = JSONObject(execute(builder("/api/articles/$articleId/audio").get().build()))
        val arr = o.optJSONArray("paragraphOffsetsMs")
        val offsets = IntArray(arr?.length() ?: 0) { arr!!.getInt(it) }
        AudioMeta(
            ready = o.optBoolean("ready", false),
            enabled = o.optBoolean("enabled", true),
            durationMs = o.optInt("durationMs", 0),
            sampleRate = o.optInt("sampleRate", 24000),
            format = o.optString("format", "wav"),
            offsetsMs = offsets
        )
    } catch (_: Exception) {
        null
    }

    /** POST /api/articles/{id}/audio — force (re)generation. */
    suspend fun requestAudioGeneration(articleId: String) {
        runCatching {
            execute(builder("/api/articles/$articleId/audio").post(ByteArray(0).toRequestBody()).build())
        }
    }

    /** GET /api/articles/{id}/audio.<format> — stream the audio to [dest]. */
    suspend fun downloadAudio(articleId: String, format: String, dest: java.io.File): Boolean = withContext(Dispatchers.IO) {
        try {
            val resp = client.newCall(builder("/api/articles/$articleId/audio.$format").get().build()).execute()
            resp.use { r ->
                if (!r.isSuccessful) return@withContext false
                val body = r.body ?: return@withContext false
                dest.outputStream().use { out -> body.byteStream().copyTo(out) }
            }
            dest.length() > 44
        } catch (_: Exception) {
            dest.delete(); false
        }
    }

    /** POST /api/save-url — server fetches + extracts the page. Returns the
     *  saved article's title, or throws on failure. */
    suspend fun saveUrl(sharedText: String): String {
        val json = JSONObject().put("url", sharedText)
        val body = execute(
            builder("/api/save-url")
                .post(json.toString().toRequestBody(jsonMediaType))
                .build()
        )
        return JSONObject(body).optString("title", "Saved")
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
        ttsParagraph = o.optInt("ttsParagraph", 0),
        wordCount = o.optInt("wordCount", 0),
        imageUrl = o.stringOrNull("imageUrl"),
        publishedAt = if (o.has("publishedAt") && !o.isNull("publishedAt")) o.optLong("publishedAt") else null,
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
