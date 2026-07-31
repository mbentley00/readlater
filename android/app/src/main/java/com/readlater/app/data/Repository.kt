package com.readlater.app.data

import androidx.room.withTransaction
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID

/**
 * Offline-first repository. The Room database is the source of truth for the UI;
 * the server is reconciled via [syncNow] plus opportunistic background pushes.
 * The app must remain fully usable offline — network failures are swallowed for
 * opportunistic pushes and surfaced as a [Result] failure only from explicit sync.
 */
class Repository(
    private val db: AppDatabase,
    private val api: ApiClient,
    private val settings: Settings
) {

    private val articleDao = db.articleDao()
    private val highlightDao = db.highlightDao()
    private val bgScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    fun articles(archived: Boolean): Flow<List<ArticleEntity>> =
        articleDao.articlesByArchived(archived)

    fun allArticles(): Flow<List<ArticleEntity>> = articleDao.allArticlesFlow()

    /** Whole library + per-article highlight counts, fetched once off the main
     *  thread. Used to size the view chips without putting the entire library
     *  behind the inbox list. */
    suspend fun articlesForCounting(): Pair<List<ArticleEntity>, Map<String, Int>> =
        withContext(Dispatchers.IO) {
            val all = articleDao.allArticlesOnce()
            val counts = highlightDao.countsByArticleOnce().associate { it.articleId to it.n }
            all to counts
        }

    fun highlightCounts(): Flow<List<HighlightCount>> = highlightDao.countsByArticle()

    suspend fun fetchViews(): List<RemoteView> = api.listViews().also {
        settings.cachedViewsJson = viewsToJson(it)
    }

    /** Locally cached views — shown instantly while [fetchViews] refreshes. */
    fun cachedViews(): List<RemoteView> = jsonToViews(settings.cachedViewsJson)

    suspend fun createView(name: String, view: RemoteView): RemoteView = api.createView(name, view)

    suspend fun deleteView(id: String) = api.deleteView(id)

    /**
     * Never import paragraphs containing [phrase] again. Server-side and
     * forward-looking only: articles already saved keep their text, because
     * highlights and reading positions are anchored to paragraph indices.
     * Resolves to the number of already-saved articles containing the phrase.
     */
    suspend fun addSkipRule(phrase: String): Result<Int> = withContext(Dispatchers.IO) {
        runCatching { api.addSkipRule(phrase) }
    }

    private fun viewsToJson(views: List<RemoteView>): String {
        val arr = org.json.JSONArray()
        views.forEach { v ->
            arr.put(org.json.JSONObject().apply {
                put("id", v.id); put("name", v.name); put("q", v.q); put("domain", v.domain)
                put("highlighted", v.highlighted); put("minWords", v.minWords)
                put("maxWords", v.maxWords); put("minHighlights", v.minHighlights)
                put("includeArchived", v.includeArchived)
            })
        }
        return arr.toString()
    }

    private fun jsonToViews(s: String): List<RemoteView> {
        if (s.isBlank()) return emptyList()
        return runCatching {
            val arr = org.json.JSONArray(s)
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                RemoteView(
                    id = o.getString("id"), name = o.optString("name"), q = o.optString("q"),
                    domain = o.optString("domain"), highlighted = o.optBoolean("highlighted"),
                    minWords = o.optInt("minWords"), maxWords = o.optInt("maxWords"),
                    minHighlights = o.optInt("minHighlights"), includeArchived = o.optBoolean("includeArchived")
                )
            }
        }.getOrDefault(emptyList())
    }

    fun article(id: String): Flow<ArticleEntity?> = articleDao.articleFlow(id)

    /** The next inbox article to auto-play after finishing/archiving this one. */
    suspend fun nextInboxArticle(current: ArticleEntity): ArticleEntity? =
        withContext(Dispatchers.IO) { articleDao.nextInboxAfter(current.savedAt, current.id) }

    /**
     * Ordered article ids of the view the user last opened an article from — the
     * inbox/archive tab, a saved view, search results, in the current sort order.
     * Queued ("play through") playback walks THIS order so it follows the view you
     * were on rather than the global inbox. Set by the list screen when it opens an
     * article; read by both the service (to advance) and the reader (to show what's
     * next up).
     */
    @Volatile
    var playQueue: List<String> = emptyList()

    /** The id after [currentId] in the captured view order, or null if it's last
     *  or the view isn't captured. Cheap enough for the reader's "next up" line. */
    fun nextIdInView(currentId: String): String? {
        val q = playQueue
        val i = q.indexOf(currentId)
        return if (i in 0 until q.lastIndex) q[i + 1] else null
    }

    /**
     * The next article to auto-play after [current] when playing through. Prefers
     * the captured view order ([playQueue]) so queued playback stays within the
     * view you were on; falls back to the global inbox order when [current] isn't
     * part of a captured view (e.g. opened from a deep link or notification).
     */
    suspend fun nextAfterInView(current: ArticleEntity): ArticleEntity? =
        withContext(Dispatchers.IO) {
            val q = playQueue
            val i = q.indexOf(current.id)
            if (i < 0) return@withContext nextInboxArticle(current)
            for (j in i + 1 until q.size) {
                val a = articleDao.getById(q[j])
                if (a != null) return@withContext a
            }
            null // reached the end of the view
        }

    fun highlightsFor(articleId: String): Flow<List<HighlightEntity>> =
        highlightDao.byArticle(articleId)

    fun allHighlights(): Flow<List<HighlightWithArticle>> = highlightDao.allWithArticle()

    /**
     * Two-way sync:
     * 1. push dirty article metadata (PATCH) and clear dirty flags;
     * 2. push unsynced highlights (POST, idempotent via clientId);
     * 3. pull article metadata — a DELTA (updatedAt > last sync) by default,
     *    the full list when [full] is set — batching the upserts and skipping
     *    unchanged rows so a 20k-article library syncs in moments;
     * 4. on full syncs only, delete local articles gone from the server;
     * 5. fetch bodies for inbox articles whose html is missing or stale.
     */
    suspend fun syncNow(full: Boolean = false): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val syncStartedAt = System.currentTimeMillis()

            // 1. Push local metadata changes. Clear each dirty flag only if the
            //    row still matches what we sent — see clearDirtyIfUnchanged.
            for (a in articleDao.getDirty()) {
                api.patchArticle(
                    a.id,
                    archived = a.archived,
                    favorite = a.favorite,
                    readParagraph = a.readParagraph,
                    ttsParagraph = a.ttsParagraph
                )
                articleDao.clearDirtyIfUnchanged(
                    a.id, a.readParagraph, a.ttsParagraph, a.archived, a.favorite
                )
            }

            // 2. Push unsynced highlights.
            for (h in highlightDao.getUnsynced()) {
                val remote = api.postHighlight(h)
                highlightDao.markSynced(h.clientId, remote.id)
            }

            // 3. Pull article metadata (delta unless a full sync was asked for,
            //    with a safety overlap so clock skew can't drop updates).
            val since = if (full) 0L else (settings.lastSyncAt - 10 * 60 * 1000L).coerceAtLeast(0L)
            val remoteArticles = api.listArticles(since)
            // A delta sync only touches the articles it returned, so load just
            // those local rows (getAll pulls all ~24k every time — including the
            // cached inbox bodies — which is needlessly slow). Full syncs need
            // the complete set for deletion detection below.
            val localById = if (full) {
                articleDao.getAll().associateBy { it.id }
            } else {
                articleDao.getByIds(remoteArticles.map { it.id }).associateBy { it.id }
            }
            val needsBody = mutableListOf<String>()

            // The merge runs in one transaction so a local write cannot slip in
            // between reading the dirty set and applying the pull. Both orderings
            // are then safe: a write that lands first is seen as pending below, and
            // one that lands after simply overwrites the row and re-marks it dirty.
            db.withTransaction {
                // Anything still dirty here changed locally *after* step 1 pushed —
                // typically the listening position, which TTS advances every
                // paragraph while this sync is doing network I/O. The server copy we
                // just pulled is older than these, so local wins and the row stays
                // dirty for the next push. Without this, a sync during playback
                // silently rewinds it to wherever it was when the sync started.
                val pendingById = articleDao.getDirty().associateBy { it.id }
                val changed = mutableListOf<ArticleEntity>()

                for (r in remoteArticles) {
                    val local = localById[r.id]
                    val pending = pendingById[r.id]
                    val merged = ArticleEntity(
                        id = r.id,
                        url = r.url,
                        title = r.title,
                        byline = r.byline,
                        siteName = r.siteName,
                        excerpt = r.excerpt,
                        // Preserve the cached body; step 5 refreshes it when stale.
                        html = local?.html,
                        savedAt = r.savedAt,
                        updatedAt = r.updatedAt,
                        // Unpushed local edits outrank the server's older copy.
                        archived = pending?.archived ?: r.archived,
                        favorite = pending?.favorite ?: r.favorite,
                        readParagraph = pending?.readParagraph ?: r.readParagraph,
                        ttsParagraph = pending?.ttsParagraph ?: r.ttsParagraph,
                        dirty = pending != null,
                        wordCount = r.wordCount,
                        paragraphCount = local?.paragraphCount ?: 0,
                        imageUrl = r.imageUrl,
                        publishedAt = r.publishedAt,
                        source = r.source,
                        // archivedAt is local-only; keep whatever we recorded on archive.
                        archivedAt = local?.archivedAt
                    )
                    if (local == null || local.copy(html = null, paragraphCount = 0) !=
                        merged.copy(html = null, paragraphCount = 0)
                    ) {
                        changed.add(merged)
                    }
                    // Only inbox articles get their bodies eagerly; archived ones
                    // load on demand in the reader (keeps a large imported library
                    // from downloading hundreds of MB to the phone).
                    if (!merged.archived && (local?.html == null || r.updatedAt > local.updatedAt)) {
                        needsBody.add(r.id)
                    }
                }
                if (changed.isNotEmpty()) articleDao.upsertAll(changed)
            }

            // 4. Deletions can only be detected against the complete list.
            if (full) {
                val remoteIds = remoteArticles.map { it.id }.toSet()
                for (local in localById.values) {
                    if (local.id !in remoteIds) {
                        articleDao.deleteById(local.id)
                        highlightDao.deleteByArticle(local.id)
                    }
                }
            }

            // 5. Fetch missing/stale bodies.
            for (id in needsBody) {
                val fullArticle = api.getArticle(id)
                articleDao.setHtml(id, fullArticle.html, paragraphCountOf(fullArticle.html))
            }

            settings.lastSyncAt = syncStartedAt
        }
    }

    /** Fetch a single article body on demand (used by the reader's retry button). */
    suspend fun fetchArticleBody(id: String): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val full = api.getArticle(id)
            articleDao.setHtml(id, full.html, paragraphCountOf(full.html))
        }
    }

    private fun paragraphCountOf(html: String?): Int =
        html?.let { HtmlParser.parse(it).size } ?: 0

    /**
     * Ask the server to re-extract a mis-parsed article ([hint] = "too-short" |
     * "too-long" | "other"). On success the server has reset the read/listen
     * positions (the parse changed), and we replace the local copy with the
     * returned article. Returns the result so the UI can report success/reason.
     */
    suspend fun reparseArticle(id: String, hint: String): ApiClient.ReparseResult = withContext(Dispatchers.IO) {
        val result = api.reparse(id, hint)
        val r = result.article
        if (result.ok && r != null) {
            // Reparse rebuilds the row from the server; carry the local-only
            // archivedAt forward so a reparsed archived article keeps its order.
            val archivedAt = articleDao.getById(r.id)?.archivedAt
            articleDao.upsertAll(listOf(ArticleEntity(
                id = r.id, url = r.url, title = r.title, byline = r.byline, siteName = r.siteName,
                excerpt = r.excerpt, html = r.html, savedAt = r.savedAt, updatedAt = r.updatedAt,
                archived = r.archived, favorite = r.favorite, readParagraph = r.readParagraph,
                ttsParagraph = r.ttsParagraph, dirty = false, wordCount = r.wordCount,
                paragraphCount = paragraphCountOf(r.html), imageUrl = r.imageUrl, publishedAt = r.publishedAt,
                source = r.source, archivedAt = archivedAt
            )))
        }
        result
    }

    /** Raw captured/fetched original source for "view original". */
    suspend fun articleSource(id: String): ApiClient.ArticleSource = api.articleSource(id)

    fun toggleArchive(article: ArticleEntity) {
        bgScope.launch {
            val nowArchived = !article.archived
            // Stamp when it was archived so the Archive tab can order by it;
            // clear it on unarchive.
            articleDao.setArchived(article.id, nowArchived, if (nowArchived) System.currentTimeMillis() else null)
            pushMetadata(article.id)
        }
    }

    fun toggleFavorite(article: ArticleEntity) {
        bgScope.launch {
            articleDao.setFavorite(article.id, !article.favorite)
            pushMetadata(article.id)
        }
    }

    fun saveReadPosition(articleId: String, paragraphIndex: Int) {
        bgScope.launch {
            articleDao.setReadParagraph(articleId, paragraphIndex)
            pushMetadata(articleId)
        }
    }

    /**
     * Save the read position locally only — no immediate network call. The dirty
     * flag defers the push to the next sync (or the next pushing save). Meant for
     * high-frequency callers: scroll tracking and per-paragraph TTS advances.
     */
    fun saveReadPositionLocal(articleId: String, paragraphIndex: Int) {
        bgScope.launch {
            articleDao.setReadParagraph(articleId, paragraphIndex)
        }
    }

    /** Listening position — tracked separately from the manual scroll position. */
    fun saveTtsPosition(articleId: String, paragraphIndex: Int) {
        bgScope.launch {
            articleDao.setTtsParagraph(articleId, paragraphIndex)
            pushMetadata(articleId)
        }
    }

    fun saveTtsPositionLocal(articleId: String, paragraphIndex: Int) {
        bgScope.launch {
            articleDao.setTtsParagraph(articleId, paragraphIndex)
        }
    }

    fun addHighlight(articleId: String, text: String, note: String?, paragraphIndex: Int) {
        bgScope.launch {
            val highlight = HighlightEntity(
                clientId = UUID.randomUUID().toString(),
                serverId = null,
                articleId = articleId,
                text = text,
                note = note,
                paragraphIndex = paragraphIndex,
                createdAt = System.currentTimeMillis(),
                synced = false
            )
            highlightDao.upsert(highlight)
            try {
                val remote = api.postHighlight(highlight)
                highlightDao.markSynced(highlight.clientId, remote.id)
            } catch (_: Exception) {
                // Offline — will be pushed by the next syncNow().
            }
        }
    }

    fun deleteHighlight(clientId: String, serverId: String?) {
        bgScope.launch {
            highlightDao.deleteByClientId(clientId)
            if (serverId != null) {
                try {
                    api.deleteHighlight(serverId)
                } catch (_: Exception) {
                    // Best effort; server copy will linger until deleted online.
                }
            }
        }
    }

    fun deleteArticle(article: ArticleEntity) {
        bgScope.launch {
            articleDao.deleteById(article.id)
            highlightDao.deleteByArticle(article.id)
            try {
                api.deleteArticle(article.id)
            } catch (_: Exception) {
                // Best effort.
            }
        }
    }

    /** Push the article's full mutable metadata; keep it dirty if the network fails. */
    private suspend fun pushMetadata(articleId: String) {
        val a = articleDao.getById(articleId) ?: return
        try {
            api.patchArticle(
                a.id,
                archived = a.archived,
                favorite = a.favorite,
                readParagraph = a.readParagraph,
                ttsParagraph = a.ttsParagraph
            )
            // Only if nothing moved while the PATCH was in flight; otherwise the
            // row stays dirty so the newer value still gets pushed.
            articleDao.clearDirtyIfUnchanged(
                a.id, a.readParagraph, a.ttsParagraph, a.archived, a.favorite
            )
        } catch (_: Exception) {
            // Offline — stays dirty and is pushed on the next syncNow().
        }
    }
}
