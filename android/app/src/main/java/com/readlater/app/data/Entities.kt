package com.readlater.app.data

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

// The url index is what keeps a lookup by url off the whole table: rows carry
// their html inline, so a scan reads the library's bodies off disk to find one
// row. PodcastFiles.sweep does exactly such a lookup, once per stored episode,
// at the end of every sync.
@Entity(tableName = "articles", indices = [Index("url")])
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
    val imageUrl: String? = null,
    /** Original publish date (ms), null if the page didn't expose one. */
    val publishedAt: Long? = null,
    /** How the article was saved (browser-page / browser-link / android-share /
     *  email / …). A debugging aid for parse failures; null on older articles. */
    val source: String? = null,
    /** When this was archived (ms), so the Archive tab can order by it. Local
     *  only; set on archive, cleared on unarchive, null if never archived. */
    val archivedAt: Long? = null,
    /** The server thinks this save didn't work — a 403, a consent wall, a page
     *  that never parsed (server/quality.js). Kept out of the main list. */
    @ColumnInfo(defaultValue = "0") val problem: Boolean = false,
    /** One line saying what went wrong, for the Problems list. */
    val problemDetail: String? = null,
    /** Where this episode's audio can be downloaded from, for an episode that
     *  arrived from a subscribed feed. Null for everything else. */
    val audioUrl: String? = null
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

/** Whether an article is still in the inbox — a projection, so reading it does
 *  not pull the article's html along too. */
data class ArticleState(val id: String, val archived: Boolean)

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

/** A podcast episode: from a subscribed feed (it has audio to fetch), or
 *  shared out of a player (the server names those by the audio's hash). */
fun isPodcastEpisode(url: String, audioUrl: String?): Boolean =
    audioUrl != null || url.startsWith(PodcastFiles.URL_PREFIX)

fun ArticleEntity.isPodcast(): Boolean = isPodcastEpisode(url, audioUrl)
