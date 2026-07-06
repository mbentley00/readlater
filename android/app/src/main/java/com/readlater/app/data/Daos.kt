package com.readlater.app.data

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface ArticleDao {

    @Query("SELECT * FROM articles WHERE archived = :archived ORDER BY savedAt DESC")
    fun articlesByArchived(archived: Boolean): Flow<List<ArticleEntity>>

    @Query("SELECT * FROM articles ORDER BY savedAt DESC")
    fun allArticlesFlow(): Flow<List<ArticleEntity>>

    @Query("SELECT * FROM articles WHERE id = :id")
    fun articleFlow(id: String): Flow<ArticleEntity?>

    @Query("SELECT * FROM articles WHERE id = :id")
    suspend fun getById(id: String): ArticleEntity?

    @Query("SELECT * FROM articles")
    suspend fun getAll(): List<ArticleEntity>

    @Query("SELECT * FROM articles WHERE dirty = 1")
    suspend fun getDirty(): List<ArticleEntity>

    @Upsert
    suspend fun upsert(article: ArticleEntity)

    @Query("UPDATE articles SET dirty = 0 WHERE id = :id")
    suspend fun clearDirty(id: String)

    @Query("UPDATE articles SET html = :html, paragraphCount = :paragraphCount WHERE id = :id")
    suspend fun setHtml(id: String, html: String?, paragraphCount: Int)

    @Query("UPDATE articles SET archived = :archived, dirty = 1 WHERE id = :id")
    suspend fun setArchived(id: String, archived: Boolean)

    @Query("UPDATE articles SET favorite = :favorite, dirty = 1 WHERE id = :id")
    suspend fun setFavorite(id: String, favorite: Boolean)

    @Query("UPDATE articles SET readParagraph = :paragraph, dirty = 1 WHERE id = :id")
    suspend fun setReadParagraph(id: String, paragraph: Int)

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
