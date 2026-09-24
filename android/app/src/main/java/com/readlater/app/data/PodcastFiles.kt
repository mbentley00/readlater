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

    /** Move a spooled episode into the store under its hash. Replaces an
     *  earlier copy of the same episode. Returns the stored file. */
    fun keep(spool: File, hash: String, ext: String): File {
        dir.mkdirs()
        val safeExt = ext.lowercase().takeIf { it.matches(Regex("[a-z0-9]{1,5}")) } ?: "mp3"
        delete(URL_PREFIX + hash)
        val target = File(dir, "$hash.$safeExt")
        if (!spool.renameTo(target)) {
            spool.copyTo(target, overwrite = true)
            spool.delete()
        }
        return target
    }

    /** The stored episode for an article url, or null (not an episode, or not on this phone). */
    fun forUrl(url: String): File? {
        val hash = hashOfUrl(url) ?: return null
        return files().firstOrNull { it.name.substringBeforeLast('.') == hash && it.length() > 0 }
    }

    /** Drop the stored episode for an article url, if any. */
    fun delete(url: String) {
        val hash = hashOfUrl(url) ?: return
        files().filter { it.name.substringBeforeLast('.') == hash }.forEach { it.delete() }
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
            val url = URL_PREFIX + f.name.substringBeforeLast('.')
            val state = stateFor(url)
            val gone = if (state == null) now - f.lastModified() > ORPHAN_MS else state.archived
            if (gone) f.delete()
        }
    }
}
