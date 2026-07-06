package com.readlater.app.data

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
    db: AppDatabase,
    private val api: ApiClient,
    private val settings: Settings
) {

    private val articleDao = db.articleDao()
    private val highlightDao = db.highlightDao()
    private val bgScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    fun articles(archived: Boolean): Flow<List<ArticleEntity>> =
        articleDao.articlesByArchived(archived)

    fun allArticles(): Flow<List<ArticleEntity>> = articleDao.allArticlesFlow()

    fun highlightCounts(): Flow<List<HighlightCount>> = highlightDao.countsByArticle()

    suspend fun fetchViews(): List<RemoteView> = api.listViews()

    fun article(id: String): Flow<ArticleEntity?> = articleDao.articleFlow(id)

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

            // 1. Push local metadata changes.
            for (a in articleDao.getDirty()) {
                api.patchArticle(
                    a.id,
                    archived = a.archived,
                    favorite = a.favorite,
                    readParagraph = a.readParagraph,
                    ttsParagraph = a.ttsParagraph
                )
                articleDao.clearDirty(a.id)
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
            val localById = articleDao.getAll().associateBy { it.id }
            val needsBody = mutableListOf<String>()
            val changed = mutableListOf<ArticleEntity>()

            for (r in remoteArticles) {
                val local = localById[r.id]
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
                    archived = r.archived,
                    favorite = r.favorite,
                    readParagraph = r.readParagraph,
                    ttsParagraph = r.ttsParagraph,
                    dirty = false,
                    wordCount = r.wordCount,
                    paragraphCount = local?.paragraphCount ?: 0
                )
                if (local == null || local.copy(html = null, paragraphCount = 0) !=
                    merged.copy(html = null, paragraphCount = 0)
                ) {
                    changed.add(merged)
                }
                // Only inbox articles get their bodies eagerly; archived ones
                // load on demand in the reader (keeps a large imported library
                // from downloading hundreds of MB to the phone).
                if (!r.archived && (local?.html == null || r.updatedAt > local.updatedAt)) {
                    needsBody.add(r.id)
                }
            }
            if (changed.isNotEmpty()) articleDao.upsertAll(changed)

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

    fun toggleArchive(article: ArticleEntity) {
        bgScope.launch {
            articleDao.setArchived(article.id, !article.archived)
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
            articleDao.clearDirty(a.id)
        } catch (_: Exception) {
            // Offline — stays dirty and is pushed on the next syncNow().
        }
    }
}
