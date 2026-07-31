package com.readlater.app.data

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface ArticleDao {

    // List flows deliberately DON'T load the (large) html column — the list and
    // view filters never use it, and loading every inbox body (tens of MB) is
    // what made selecting a view slow. The reader fetches html separately by id.
    @Query(
        "SELECT id, url, title, byline, siteName, excerpt, NULL AS html, savedAt, updatedAt, " +
            "archived, favorite, readParagraph, dirty, wordCount, paragraphCount, ttsParagraph, " +
            "imageUrl, publishedAt FROM articles WHERE archived = :archived ORDER BY savedAt DESC"
    )
    fun articlesByArchived(archived: Boolean): Flow<List<ArticleEntity>>

    @Query(
        "SELECT id, url, title, byline, siteName, excerpt, NULL AS html, savedAt, updatedAt, " +
            "archived, favorite, readParagraph, dirty, wordCount, paragraphCount, ttsParagraph, " +
            "imageUrl, publishedAt FROM articles ORDER BY savedAt DESC"
    )
    fun allArticlesFlow(): Flow<List<ArticleEntity>>

    /**
     * One-shot version of [allArticlesFlow], for counting how many articles each
     * saved view holds. A *flow* over the whole library would keep tens of
     * thousands of rows live behind the inbox — which only needs a few hundred —
     * so the counts are computed once in the background instead, and are allowed
     * to lag a little rather than slow the list down.
     */
    @Query(
        "SELECT id, url, title, byline, siteName, excerpt, NULL AS html, savedAt, updatedAt, " +
            "archived, favorite, readParagraph, dirty, wordCount, paragraphCount, ttsParagraph, " +
            "imageUrl, publishedAt FROM articles"
    )
    suspend fun allArticlesOnce(): List<ArticleEntity>

    @Query("SELECT * FROM articles WHERE id = :id")
    fun articleFlow(id: String): Flow<ArticleEntity?>

    @Query("SELECT * FROM articles WHERE id = :id")
    suspend fun getById(id: String): ArticleEntity?

    /** Next inbox article after the given one, in newest-first (list) order. */
    @Query(
        "SELECT * FROM articles WHERE archived = 0 AND html IS NOT NULL AND " +
            "(savedAt < :savedAt OR (savedAt = :savedAt AND id > :id)) " +
            "ORDER BY savedAt DESC, id ASC LIMIT 1"
    )
    suspend fun nextInboxAfter(savedAt: Long, id: String): ArticleEntity?

    @Query("SELECT * FROM articles")
    suspend fun getAll(): List<ArticleEntity>

    @Query("SELECT * FROM articles WHERE id IN (:ids)")
    suspend fun getByIds(ids: List<String>): List<ArticleEntity>

    @Query("SELECT * FROM articles WHERE dirty = 1")
    suspend fun getDirty(): List<ArticleEntity>

    @Upsert
    suspend fun upsert(article: ArticleEntity)

    /** One transaction for the whole batch — vastly faster than row-by-row. */
    @Upsert
    suspend fun upsertAll(articles: List<ArticleEntity>)

    /**
     * Clear the dirty flag only if the row still holds exactly what we pushed.
     * Playback advances the listening position from another coroutine while a
     * PATCH is in flight; clearing unconditionally would drop that newer value
     * on the floor — it would never be pushed, and the next pull would
     * overwrite it with the older server copy.
     */
    @Query(
        "UPDATE articles SET dirty = 0 WHERE id = :id AND readParagraph = :readParagraph " +
            "AND ttsParagraph = :ttsParagraph AND archived = :archived AND favorite = :favorite"
    )
    suspend fun clearDirtyIfUnchanged(
        id: String,
        readParagraph: Int,
        ttsParagraph: Int,
        archived: Boolean,
        favorite: Boolean
    )

    @Query("UPDATE articles SET html = :html, paragraphCount = :paragraphCount WHERE id = :id")
    suspend fun setHtml(id: String, html: String?, paragraphCount: Int)

    @Query("UPDATE articles SET archived = :archived, archivedAt = :archivedAt, dirty = 1 WHERE id = :id")
    suspend fun setArchived(id: String, archived: Boolean, archivedAt: Long?)

    @Query("UPDATE articles SET favorite = :favorite, dirty = 1 WHERE id = :id")
    suspend fun setFavorite(id: String, favorite: Boolean)

    @Query("UPDATE articles SET readParagraph = :paragraph, dirty = 1 WHERE id = :id")
    suspend fun setReadParagraph(id: String, paragraph: Int)

    @Query("UPDATE articles SET ttsParagraph = :paragraph, dirty = 1 WHERE id = :id")
    suspend fun setTtsParagraph(id: String, paragraph: Int)

    @Query("DELETE FROM articles WHERE id = :id")
    suspend fun deleteById(id: String)
}

data class HighlightCount(val articleId: String, val n: Int)

@Dao
interface HighlightDao {

    @Query("SELECT * FROM highlights WHERE articleId = :articleId ORDER BY createdAt ASC")
    fun byArticle(articleId: String): Flow<List<HighlightEntity>>

    @Query("SELECT articleId, COUNT(*) AS n FROM highlights GROUP BY articleId")
    fun countsByArticle(): Flow<List<HighlightCount>>

    /** One-shot counts, for the background view-count pass (see allArticlesOnce). */
    @Query("SELECT articleId, COUNT(*) AS n FROM highlights GROUP BY articleId")
    suspend fun countsByArticleOnce(): List<HighlightCount>

    @Query(
        "SELECT h.clientId, h.serverId, h.articleId, h.text, h.note, h.paragraphIndex, " +
            "h.createdAt, h.synced, a.title AS articleTitle " +
            "FROM highlights h JOIN articles a ON a.id = h.articleId " +
            "ORDER BY h.createdAt DESC"
    )
    fun allWithArticle(): Flow<List<HighlightWithArticle>>

    @Query("SELECT * FROM highlights WHERE synced = 0")
    suspend fun getUnsynced(): List<HighlightEntity>

    @Upsert
    suspend fun upsert(highlight: HighlightEntity)

    @Query("UPDATE highlights SET serverId = :serverId, synced = 1 WHERE clientId = :clientId")
    suspend fun markSynced(clientId: String, serverId: String)

    @Query("DELETE FROM highlights WHERE clientId = :clientId")
    suspend fun deleteByClientId(clientId: String)

    @Query("DELETE FROM highlights WHERE articleId = :articleId")
    suspend fun deleteByArticle(articleId: String)
}
