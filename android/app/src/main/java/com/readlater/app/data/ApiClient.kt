package com.readlater.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import okio.source
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.net.URLEncoder
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
    val html: String?,
    /** How the article was saved (browser-page / browser-link / android-share /
     *  email / …), for diagnosing parse failures. Null on older articles. */
    val source: String?,
    /** The server flagged this save as not having worked (server/quality.js). */
    val problem: Boolean = false,
    /** One line saying what went wrong. */
    val problemDetail: String? = null,
    /** Where to download this episode's audio (feed episodes only). */
    val audioUrl: String? = null
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

/** A podcast subscription as returned by GET /api/feeds. */
data class RemoteFeed(
    val id: String,
    val url: String,
    val title: String,
    /** Episodes imported so far (the back catalogue is never imported). */
    val episodes: Int,
    val lastCheckedAt: Long?,
    val lastError: String?
)

/** A subscribed show, for the Podcasts tab's show filter. */
data class PodcastShow(
    val id: String,
    val title: String,
    val imageUrl: String?,
    val autoProcess: Boolean
)

/** A feed episode not yet processed — waiting to be picked (or archived). */
data class WaitingEpisode(
    val feedId: String,
    val guid: String,
    val title: String,
    val publishedAt: Long?,
    val durationS: Int?,
    val imageUrl: String?
)

/** An episode in a show's feed, from GET /api/feeds/{id}/backlog: the back
 *  catalogue, with what became of each one. */
data class BacklogEpisode(
    val guid: String,
    val title: String,
    val publishedAt: Long?,
    val durationS: Int?,
    val imageUrl: String?,
    /** "available" (can be processed), "waiting" (under New), "processed". */
    val state: String,
    /** The article it became, once processed. */
    val articleId: String?
)

/** GET /api/podcasts: shows, waiting episodes, and which show each
 *  processed episode (article id → feed id) came from. */
data class PodcastsData(
    val shows: List<PodcastShow>,
    val waiting: List<WaitingEpisode>,
    val episodeShow: Map<String, String>
)

/** What POST /api/feeds said about a new subscription. */
data class FeedAdded(val title: String, val existingEpisodes: Int, val alreadySubscribed: Boolean)

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

    // Uploading a two-hour episode over mobile data takes far longer than any
    // other call this app makes, and the write timeout above is what would end
    // it. Shares the connection pool with [client]; only the clocks differ.
    private val uploadClient by lazy {
        client.newBuilder()
            .writeTimeout(0, TimeUnit.MILLISECONDS)
            .readTimeout(5, TimeUnit.MINUTES)
            .build()
    }

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()
    private val audioMediaType = "application/octet-stream".toMediaType()

    private fun builder(path: String): Request.Builder {
        val base = settings.serverUrl
        if (base.isBlank()) {
            throw IOException("Server URL is not configured. Open Settings first.")
        }
        return Request.Builder()
            .url(base + path)
            .header("Authorization", "Bearer ${settings.token}")
    }

    private suspend fun execute(
        request: Request,
        httpClient: OkHttpClient = client,
    ): String = withContext(Dispatchers.IO) {
        val response = try {
            httpClient.newCall(request).execute()
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
        val qs = (if (since > 0) "&since=$since" else "") +
            // Hark wants episodes only. Asking the server for them, rather than
            // filtering the whole library here, matters: the full list is
            // ~25k rows and takes the server over a minute to build.
            (if (com.readlater.app.BuildConfig.PODCAST_APP) "&podcasts=1" else "")
        val body = execute(builder("/api/articles?includeArchived=1$qs").get().build())
        val arr = JSONObject(body).getJSONArray("articles")
        return (0 until arr.length()).map { parseArticle(arr.getJSONObject(it)) }
    }

    /** GET /api/app-version — metadata of the newest APK of this app uploaded to
     *  the server (Hark's is ?app=podcasts, apart from Earmark's). */
    suspend fun latestAppVersion(): Pair<String, Int>? = try {
        val app = com.readlater.app.BuildConfig.APK_NAME
        val body = execute(builder("/api/app-version" + if (app.isEmpty()) "" else "?app=$app").get().build())
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

    /** A sleep-mode pick from outside the library (server/sleep.js). */
    data class SleepCandidate(
        val url: String, val title: String, val byline: String?, val siteName: String?,
        val excerpt: String?, val wordCount: Int, val source: String
    )

    /** POST /api/sleep/candidate — a random long article from [source]
     *  ("historylink" | "cambridge") that isn't saved yet, skipping [exclude]. */
    suspend fun sleepCandidate(source: String, exclude: Collection<String>): SleepCandidate {
        val json = JSONObject().put("source", source).put("exclude", org.json.JSONArray(exclude.toList()))
        val o = JSONObject(execute(builder("/api/sleep/candidate").post(json.toString().toRequestBody(jsonMediaType)).build()))
        return SleepCandidate(
            url = o.getString("url"), title = o.optString("title", o.getString("url")),
            byline = o.stringOrNull("byline"), siteName = o.stringOrNull("siteName"),
            excerpt = o.stringOrNull("excerpt"), wordCount = o.optInt("wordCount"), source = source
        )
    }

    /** POST /api/sleep/save — save a sleep candidate into the archive; the
     *  full article comes back. */
    suspend fun sleepSave(url: String): RemoteArticle {
        val json = JSONObject().put("url", url)
        return parseArticle(JSONObject(execute(builder("/api/sleep/save").post(json.toString().toRequestBody(jsonMediaType)).build())))
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

    /**
     * Download a podcast episode from wherever the feed says it lives. No auth
     * header and no base url: this is someone else's CDN, not our server, and
     * the token has no business being sent to it. Uses the upload client for
     * its long timeouts — an episode is tens of MB.
     */
    suspend fun downloadEpisode(url: String, dest: java.io.File): Boolean =
        download(okhttp3.Request.Builder().url(url).get().build(), dest)

    /**
     * GET /api/articles/:id/episode — the very file the server transcribed a
     * feed episode from. Preferred over the host's copy, which has its ads
     * stitched in at other places and lengths, so the transcript's times and
     * ad breaks would not be its own. False when the server didn't keep it.
     */
    suspend fun downloadServerEpisode(articleId: String, dest: java.io.File): Boolean =
        download(builder("/api/articles/$articleId/episode").get().build(), dest)

    private suspend fun download(req: Request, dest: java.io.File): Boolean = withContext(Dispatchers.IO) {
        try {
            uploadClient.newCall(req).execute().use { r ->
                if (!r.isSuccessful) return@withContext false
                val body = r.body ?: return@withContext false
                dest.outputStream().use { out -> body.byteStream().copyTo(out, 64 * 1024) }
            }
            dest.length() > 1024
        } catch (_: Exception) {
            dest.delete(); false
        }
    }

    /** POST /api/save-url — server fetches + extracts the page. Returns the
     *  saved article's title, or throws on failure. */
    suspend fun saveUrl(sharedText: String): String {
        val json = JSONObject().put("url", sharedText).put("source", "android-share")
        val body = execute(
            builder("/api/save-url")
                .post(json.toString().toRequestBody(jsonMediaType))
                .build()
        )
        return JSONObject(body).optString("title", "Saved")
    }
    /**
     * POST /api/import/audio — a podcast episode shared out of a player, which
     * the server transcribes in the background. Returns straight away with a
     * "Transcribing…" stub (or the finished article, when this file was already
     * transcribed); the text lands on a later sync.
     *
     * The body is streamed from [openStream] rather than passed as a ByteArray:
     * a two-hour episode is ~85MB, and holding that in the heap is how a phone
     * running low on memory loses the share instead of saving it. [openStream]
     * is called per attempt, so a retry re-reads from the beginning.
     *
     * The server sniffs the format from the bytes, so the media type sent here
     * is only a hint and a wrong one costs nothing.
     */
    suspend fun importAudio(
        filename: String,
        contentLength: Long,
        openStream: () -> InputStream,
    ): RemoteArticle {
        val body = object : RequestBody() {
            override fun contentType() = audioMediaType
            override fun contentLength() = contentLength
            override fun writeTo(sink: BufferedSink) {
                openStream().use { input -> sink.writeAll(input.source()) }
            }
        }
        val response = execute(
            builder("/api/import/audio?filename=" + URLEncoder.encode(filename, "UTF-8"))
                .post(body)
                .build(),
            uploadClient,
        )
        return parseArticle(JSONObject(response))
    }

    /**
     * POST /api/skip-rules — never import paragraphs containing this phrase.
     * Applies to future saves only; nothing already saved is rewritten.
     * Returns how many already-saved articles contain the phrase, so the caller
     * can say plainly that those are left alone.
     */
    suspend fun addSkipRule(phrase: String): Int {
        val json = JSONObject().put("phrase", phrase)
        val body = execute(
            builder("/api/skip-rules")
                .post(json.toString().toRequestBody(jsonMediaType))
                .build()
        )
        return JSONObject(body).optInt("existingMatches", 0)
    }

    /** GET /api/feeds — the user's podcast subscriptions. */
    suspend fun listFeeds(): List<RemoteFeed> {
        val arr = JSONObject(execute(builder("/api/feeds").get().build())).getJSONArray("feeds")
        return (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            RemoteFeed(
                id = o.getString("id"),
                url = o.optString("url"),
                title = o.stringOrNull("title") ?: o.optString("url"),
                episodes = o.optInt("episodes", 0),
                lastCheckedAt = o.optLong("lastCheckedAt", 0L).takeIf { it > 0 },
                lastError = o.stringOrNull("lastError")
            )
        }
    }

    /**
     * POST /api/feeds — subscribe. The server reads the feed first and refuses
     * one with no audio episodes; that refusal is rethrown as its own sentence
     * rather than "Server error 400: {json}".
     */
    suspend fun addFeed(url: String): FeedAdded {
        val json = JSONObject().put("url", url)
        val body = try {
            execute(builder("/api/feeds").post(json.toString().toRequestBody(jsonMediaType)).build())
        } catch (e: IOException) {
            val reason = e.message?.substringAfter(": ", "")
                ?.let { runCatching { JSONObject(it).stringOrNull("error") }.getOrNull() }
            throw if (reason != null) IOException(reason, e) else e
        }
        val o = JSONObject(body)
        return FeedAdded(
            title = o.stringOrNull("title") ?: url,
            existingEpisodes = o.optInt("existingEpisodes", 0),
            alreadySubscribed = o.optBoolean("alreadySubscribed", false)
        )
    }

    /** GET /api/podcasts — raw JSON, so the repository can cache it as is. */
    suspend fun podcastsJson(): String = execute(builder("/api/podcasts").get().build())

    fun parsePodcasts(body: String): PodcastsData {
        val o = JSONObject(body)
        val shows = o.optJSONArray("shows") ?: org.json.JSONArray()
        val waiting = o.optJSONArray("waiting") ?: org.json.JSONArray()
        val eps = o.optJSONArray("episodes") ?: org.json.JSONArray()
        return PodcastsData(
            shows = (0 until shows.length()).map { i ->
                val s = shows.getJSONObject(i)
                PodcastShow(
                    id = s.getString("id"),
                    title = s.stringOrNull("title") ?: s.optString("url"),
                    imageUrl = s.stringOrNull("imageUrl")?.takeIf { it.isNotBlank() },
                    autoProcess = s.optBoolean("autoProcess", true)
                )
            },
            waiting = (0 until waiting.length()).map { i ->
                val w = waiting.getJSONObject(i)
                WaitingEpisode(
                    feedId = w.getString("feedId"),
                    guid = w.getString("guid"),
                    title = w.stringOrNull("title") ?: "Untitled episode",
                    publishedAt = w.optLong("publishedAt", 0L).takeIf { it > 0 },
                    durationS = w.optInt("durationS", 0).takeIf { it > 0 },
                    imageUrl = w.stringOrNull("imageUrl")?.takeIf { it.isNotBlank() }
                )
            },
            episodeShow = (0 until eps.length()).associate { i ->
                val e = eps.getJSONObject(i)
                e.getString("articleId") to e.getString("feedId")
            }
        )
    }

    /**
     * POST /api/feeds/{feedId}/episodes/(take|dismiss|restore). A take has the
     * server download the episode before answering, so it runs on the
     * long-timeout client. Returns the new article's id for a take.
     */
    suspend fun episodeAction(feedId: String, guid: String, action: String, backlog: Boolean = false): String? {
        val json = JSONObject().put("guid", guid)
        // An older episode from the back catalogue, not one waiting under New.
        if (backlog) json.put("backlog", true)
        val body = try {
            execute(
                builder("/api/feeds/$feedId/episodes/$action")
                    .post(json.toString().toRequestBody(jsonMediaType)).build(),
                if (action == "take") uploadClient else client
            )
        } catch (e: IOException) {
            val reason = e.message?.substringAfter(": ", "")
                ?.let { runCatching { JSONObject(it).stringOrNull("error") }.getOrNull() }
            throw if (reason != null) IOException(reason, e) else e
        }
        return JSONObject(body).stringOrNull("articleId")
    }

    /** GET /api/feeds/{id}/backlog — every episode the show's feed lists, newest
     *  first. The server reads the feed live, so give it time. */
    suspend fun feedBacklog(feedId: String): List<BacklogEpisode> {
        val o = JSONObject(execute(builder("/api/feeds/$feedId/backlog").get().build(), uploadClient))
        val arr = o.optJSONArray("items") ?: org.json.JSONArray()
        return (0 until arr.length()).map { i ->
            val e = arr.getJSONObject(i)
            BacklogEpisode(
                guid = e.getString("guid"),
                title = e.stringOrNull("title") ?: "Untitled episode",
                publishedAt = e.optLong("publishedAt", 0L).takeIf { it > 0 },
                durationS = e.optInt("durationS", 0).takeIf { it > 0 },
                imageUrl = e.stringOrNull("imageUrl")?.takeIf { it.isNotBlank() },
                state = e.optString("state", "available"),
                articleId = e.stringOrNull("articleId")
            )
        }
    }

    /** GET /api/feeds/{id}/episodes/notes — an episode's show notes as simple
     *  HTML ("" when the feed gives none): by guid, or by the article a
     *  processed one became. May read the feed live, so the slow client. */
    suspend fun episodeNotes(feedId: String, guid: String?, articleId: String?): String {
        val q = if (articleId != null) "articleId=" + URLEncoder.encode(articleId, "UTF-8")
            else "guid=" + URLEncoder.encode(guid.orEmpty(), "UTF-8")
        val o = JSONObject(execute(builder("/api/feeds/$feedId/episodes/notes?$q").get().build(), uploadClient))
        return o.optString("notes", "")
    }

    /** PATCH /api/feeds/{id} {autoProcess} — take new episodes by themselves,
     *  or leave them under New to be picked. */
    suspend fun setFeedAutoProcess(id: String, on: Boolean) {
        val json = JSONObject().put("autoProcess", on)
        execute(builder("/api/feeds/$id").patch(json.toString().toRequestBody(jsonMediaType)).build())
    }

    /** DELETE /api/feeds/{id} */
    suspend fun deleteFeed(id: String) {
        execute(builder("/api/feeds/$id").delete().build())
    }

    /** POST /api/feeds/check — poll every feed now. Returns new episodes taken. */
    suspend fun checkFeeds(): Int {
        val body = execute(builder("/api/feeds/check").post(ByteArray(0).toRequestBody(null)).build())
        return JSONObject(body).optInt("episodes", 0)
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

    /** Outcome of a reparse: either a fresh article, or a reason it couldn't help. */
    data class ReparseResult(val ok: Boolean, val method: String, val article: RemoteArticle?, val reason: String?)

    /** Raw captured/fetched original for "view original". */
    data class ArticleSource(val url: String, val kind: String, val source: String?)

    /**
     * POST /api/articles/{id}/reparse — re-extract a mis-parsed article given a
     * hint ("too-short" | "too-long" | "other"). The server may fetch the page
     * and call an LLM, so this can take a while — use a much longer timeout than
     * the default read timeout.
     */
    suspend fun reparse(articleId: String, hint: String): ReparseResult = withContext(Dispatchers.IO) {
        val payload = JSONObject().put("hint", hint)
        val request = builder("/api/articles/$articleId/reparse")
            .post(payload.toString().toRequestBody(jsonMediaType)).build()
        val longClient = client.newBuilder()
            .readTimeout(150, TimeUnit.SECONDS)
            .callTimeout(180, TimeUnit.SECONDS)
            .build()
        val body = try {
            longClient.newCall(request).execute()
        } catch (e: IOException) {
            throw IOException("Network error: ${e.message}", e)
        }.use { resp ->
            val b = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw IOException("Server error ${resp.code}: ${b.take(200).ifBlank { resp.message }}")
            b
        }
        val o = JSONObject(body)
        if (o.optBoolean("ok", false)) {
            ReparseResult(true, o.optString("method", ""), parseArticle(o.getJSONObject("article")), null)
        } else {
            ReparseResult(false, "", null, o.optString("reason", "unknown"))
        }
    }

    /** GET /api/articles/{id}/source — the raw original, if available. */
    suspend fun articleSource(articleId: String): ArticleSource {
        val o = JSONObject(execute(builder("/api/articles/$articleId/source").get().build()))
        return ArticleSource(o.optString("url", ""), o.optString("kind", "none"), o.stringOrNull("source"))
    }

    /** POST /api/articles/{id}/share — the public /p/… link to the parsed
     *  article, minted on first use and the same one every time after. */
    suspend fun shareLink(articleId: String): String {
        val body = execute(builder("/api/articles/$articleId/share").post(ByteArray(0).toRequestBody()).build())
        return JSONObject(body).getString("url")
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
        html = o.stringOrNull("html"),
        source = o.stringOrNull("source"),
        problem = o.optBoolean("problem", false),
        problemDetail = o.stringOrNull("problemDetail"),
        audioUrl = o.stringOrNull("audioUrl")
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
