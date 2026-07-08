package com.readlater.app.data

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "articles")
data class ArticleEntity(
    @PrimaryKey val id: String,
    val url: String,
    val title: String,
    val byline: String?,
    val siteName: String?,
    val excerpt: String?,
    /** Sanitized article HTML; null until the body has been fetched from the server. */
    val html: String?,
    val savedAt: Long,
    val updatedAt: Long,
    val archived: Boolean,
    val favorite: Boolean,
    val readParagraph: Int,
    /** True when local metadata changes have not yet been pushed to the server. */
    val dirty: Boolean,
    /** Server-computed word count of the article text (0 = unknown). */
    @ColumnInfo(defaultValue = "0") val wordCount: Int = 0,
    /** Block count from HtmlParser, set when the body is cached (0 = unknown). */
    @ColumnInfo(defaultValue = "0") val paragraphCount: Int = 0,
    /** Listening position (TTS), tracked separately from the manual scroll position. */
    @ColumnInfo(defaultValue = "0") val ttsParagraph: Int = 0,
    /** Thumbnail image URL (og:image), null if none. */
    val imageUrl: String? = null
)

@Entity(tableName = "highlights")
data class HighlightEntity(
    /** UUID generated locally; the server dedupes on this, so re-POST is safe. */
    @PrimaryKey val clientId: String,
    val serverId: String?,
    val articleId: String,
    val text: String,
    val note: String?,
    val paragraphIndex: Int,
    val createdAt: Long,
    val synced: Boolean
)

/** Highlight joined with its article's title, for the all-highlights screen. */
data class HighlightWithArticle(
    val clientId: String,
    val serverId: String?,
    val articleId: String,
    val text: String,
    val note: String?,
    val paragraphIndex: Int,
    val createdAt: Long,
    val synced: Boolean,
    val articleTitle: String
)
