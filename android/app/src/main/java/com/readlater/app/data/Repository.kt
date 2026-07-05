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
class Repository(db: AppDatabase, private val api: ApiClient) {

    private val articleDao = db.articleDao()
    private val highlightDao = db.highlightDao()
    private val bgScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    fun articles(archived: Boolean): Flow<List<ArticleEntity>> =
        articleDao.articlesByArchived(archived)

    fun article(id: String): Flow<ArticleEntity?> = articleDao.articleFlow(id)

    fun highlightsFor(articleId: String): Flow<List<HighlightEntity>> =
        highlightDao.byArticle(articleId)

    fun allHighlights(): Flow<List<HighlightWithArticle>> = highlightDao.allWithArticle()

    /**
     * Full two-way sync:
     * 1. push dirty article metadata (PATCH) and clear dirty flags;
     * 2. push unsynced highlights (POST, idempotent via clientId);
     * 3. pull the article list, upserting metadata while preserving locally cached html,
     *    and deleting local articles that no longer exist on the server;
     * 4. fetch bodies for articles whose html is missing or stale.
     */
    suspend fun syncNow(): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            // 1. Push local metadata changes.
            for (a in articleDao.getDirty()) {
                api.patchArticle(
                    a.id,
                    archived = a.archived,
                    favorite = a.favorite,
                    readParagraph = a.readParagraph
                )
                articleDao.clearDirty(a.id)
            }

            // 2. Push unsynced highlights.
            for (h in highlightDao.getUnsynced()) {
                val remote = api.postHighlight(h)
                highlightDao.markSynced(h.clientId, remote.id)
            }

            // 3. Pull article metadata.
            val remoteArticles = api.listArticles()
            val localById = articleDao.getAll().associateBy { it.id }
            val remoteIds = remoteArticles.map { it.id }.toSet()
            val needsBody = mutableListOf<String>()

            for (r in remoteArticles) {
                val local = localById[r.id]
                articleDao.upsert(
                    ArticleEntity(
                        id = r.id,
                        url = r.url,
                        title = r.title,
                        byline = r.byline,
                        siteName = r.siteName,
                        excerpt = r.excerpt,
                        // Preserve the cached body; step 4 refreshes it when stale.
                        html = local?.html,
                        savedAt = r.savedAt,
                        updatedAt = r.updatedAt,
                        archived = r.archived,
                        favorite = r.favorite,
                        readParagraph = r.readParagraph,
                        dirty = false
                    )
                )
                if (local?.html == null || r.updatedAt > local.updatedAt) {
                    needsBody.add(r.id)
                }
            }

            for (local in localById.values) {
                if (local.id !in remoteIds) {
                    articleDao.deleteById(local.id)
                    highlightDao.deleteByArticle(local.id)
                }
            }

            // 4. Fetch missing/stale bodies.
            for (id in needsBody) {
                val full = api.getArticle(id)
                articleDao.setHtml(id, full.html)
            }
        }
    }

    /** Fetch a single article body on demand (used by the reader's retry button). */
    suspend fun fetchArticleBody(id: String): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val full = api.getArticle(id)
            articleDao.setHtml(id, full.html)
        }
    }

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
                readParagraph = a.readParagraph
            )
            articleDao.clearDirty(a.id)
        } catch (_: Exception) {
            // Offline — stays dirty and is pushed on the next syncNow().
        }
    }
}
