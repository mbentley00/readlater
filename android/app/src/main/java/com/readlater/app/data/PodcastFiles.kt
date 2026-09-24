package com.readlater.app.data

import java.io.File
import java.security.MessageDigest

/**
 * Episodes shared into the app, kept on the phone so they can be played as
 * they are (rather than read aloud from the transcript).
 *
 * A file is named after the same content hash the server dedupes on — the
 * article for an uploaded episode has the url `audio:<first 24 hex of sha256>`
 * — so a file finds its article without the upload having to report back an
 * id. That matters because an episode upload often lands on the server while
 * the phone sees it fail (see ShareUploadService).
 *
 * Episodes are tens of MB, so they go as soon as they're done with: when the
 * episode finishes playing, when it is archived or deleted here, and on sync
 * for anything archived elsewhere.
 */
class PodcastFiles(private val dir: File) {

    companion object {
        const val URL_PREFIX = "audio:"

        /** A file whose article never turned up (the upload really did fail) is
         *  dropped after this long. Re-sharing the episode stores it again. */
        private const val ORPHAN_MS = 3L * 24 * 60 * 60 * 1000

        /** The server's article url for an audio file: `audio:` + 24 hex of its sha256. */
        fun hashOf(file: File): String {
            val md = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    md.update(buf, 0, n)
                }
            }
            return md.digest().joinToString("") { "%02x".format(it) }.take(24)
        }

        private fun hashOfUrl(url: String): String? =
            url.takeIf { it.startsWith(URL_PREFIX) }?.removePrefix(URL_PREFIX)
                ?.takeIf { it.matches(Regex("[0-9a-f]{24}")) }
    }

    private fun files(): List<File> = dir.listFiles()?.filter { it.isFile } ?: emptyList()

    /**
     * Move a spooled episode into the store under [key]: the audio's content
     * hash for one shared from a player, the article's id for one downloaded
     * from a feed (see [forArticle]). Replaces an earlier copy of the same
     * episode. Returns the stored file.
     */
    fun keep(spool: File, key: String, ext: String): File {
        dir.mkdirs()
        val safeExt = ext.lowercase().takeIf { it.matches(Regex("[a-z0-9]{1,5}")) } ?: "mp3"
        files().filter { it.name.substringBeforeLast('.') == key }.forEach { it.delete() }
        val target = File(dir, "$key.$safeExt")
        if (!spool.renameTo(target)) {
            spool.copyTo(target, overwrite = true)
            spool.delete()
        }
        return target
    }

    /**
     * The stored episode for an article, or null (not an episode, or not on
     * this phone).
     *
     * Two naming schemes, because there are two ways audio arrives. A shared
     * episode is named by its content hash, which is also what the server built
     * the article's `audio:` url from, so the file finds its article even when
     * the upload's reply was lost. One downloaded from a feed is named after
     * the article instead: podcast hosts stitch ads per request, so the bytes
     * we fetch need not hash to what the server fetched.
     */
    fun forArticle(articleId: String, url: String): File? {
        val names = listOfNotNull(articleId, hashOfUrl(url))
        return files().firstOrNull { it.name.substringBeforeLast('.') in names && it.length() > 0 }
    }

    /** Where a download should be written before [keep] takes it. */
    fun spoolFile(): File {
        dir.mkdirs()
        return File.createTempFile("episode", ".part", dir)
    }

    /** Drop the stored episode for an article, whichever way it was named. */
    fun delete(articleId: String?, url: String) {
        val names = listOfNotNull(articleId, hashOfUrl(url))
        if (names.isEmpty()) return
        files().filter { it.name.substringBeforeLast('.') in names }.forEach { it.delete() }
    }

    /**
     * Remove episodes nothing needs: their article is archived, or it never
     * appeared and the file is old. [stateFor] looks an article up by url.
     */
    suspend fun sweep(stateFor: suspend (String) -> ArticleState?) {
        val stored = files()
        if (stored.isEmpty()) return // the usual case: don't ask the database anything
        val now = System.currentTimeMillis()
        for (f in stored) {
            val key = f.name.substringBeforeLast('.')
            if (f.name.endsWith(".part")) { // an abandoned download
                if (now - f.lastModified() > ORPHAN_MS) f.delete()
                continue
            }
            val state = stateFor(if (key.matches(Regex("[0-9a-f]{24}"))) URL_PREFIX + key else key)
            val gone = if (state == null) now - f.lastModified() > ORPHAN_MS else state.archived
            if (gone) f.delete()
        }
    }
}
