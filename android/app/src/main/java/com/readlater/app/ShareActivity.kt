package com.readlater.app

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException

/**
 * Handles "share to Earmark" without ever showing the app. Uses a translucent,
 * no-history theme, so from the user's point of view the share sheet just
 * dismisses and a toast confirms the save.
 *
 * Two kinds of share arrive here:
 *  - a link (text/plain), saved as an article the usual way;
 *  - an audio file, which is a podcast episode shared out of a player. That
 *    goes to /api/import/audio and comes back transcribed. A player's *link* to
 *    an episode is not enough — nothing on the server resolves a podcast URL to
 *    its audio — so the file is the whole mechanism.
 *
 * The network call runs on lifecycleScope while this (invisible) activity stays
 * alive, so the save can't be lost to the process being reaped the instant we
 * finish; the toast then finishes it. Completion toasts use the application
 * context so they still appear after finish().
 */
class ShareActivity : ComponentActivity() {

    private companion object {
        /** Matches AUDIO_IMPORT_MAX_BYTES on the server, which hangs up past it.
         *  Checked here so an oversized episode says so instead of failing at the
         *  end of a long upload. */
        const val MAX_AUDIO_BYTES = 100L * 1024 * 1024

        /** Pocket Casts names a downloaded episode after its episode id, so the
         *  filename alone would title the article `fb520208-cac4-…`. */
        val OPAQUE_NAME = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9a-f]{16,}$", RegexOption.IGNORE_CASE)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val send = intent?.takeIf { it.action == Intent.ACTION_SEND }
        if (send == null) { finish(); return }

        val app = application as ReadLaterApp
        if (app.settings.token.isBlank()) {
            Toast.makeText(applicationContext, "Sign in to Earmark in Settings first", Toast.LENGTH_LONG).show()
            finish()
            return
        }

        // A player sharing an episode file often attaches its title as EXTRA_TEXT
        // as well, so the stream wins whenever there is one — saving the blurb as
        // an article instead of transcribing the episode is never what was meant.
        val stream = send.audioStream()
        if (stream != null) {
            importAudio(app, stream, send.titleHint())
            return
        }

        val shared = send.getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty()
        if (shared.isEmpty()) { finish(); return }
        saveLink(app, shared)
    }

    /** The shared audio, if this is an audio share. Trusts the intent's type over
     *  the file extension: a content:// URI from a player usually has neither a
     *  useful name nor a suffix. */
    private fun Intent.audioStream(): Uri? {
        val uri = if (Build.VERSION.SDK_INT >= 33) {
            getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            @Suppress("DEPRECATION")
            getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
        } ?: return null
        val declared = type ?: contentResolver.getType(uri) ?: ""
        return uri.takeIf { declared.startsWith("audio/") || declared == "application/ogg" }
    }

    /** A human title riding along with the file share, if the player sent one.
     *  Only used when the filename itself is opaque. A URL is not a title, and
     *  neither is a paragraph — a player that attaches show notes shouldn't get
     *  them stamped on the article. */
    private fun Intent.titleHint(): String? = listOf(Intent.EXTRA_SUBJECT, Intent.EXTRA_TITLE)
        .asSequence()
        .mapNotNull { getStringExtra(it)?.trim() }
        .plus(getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty())
        .firstOrNull { it.isNotBlank() && it.length <= 150 && !it.contains('\n') && !it.contains("://") }

    private fun saveLink(app: ReadLaterApp, shared: String) {
        Toast.makeText(applicationContext, "Saving to Earmark…", Toast.LENGTH_SHORT).show()
        lifecycleScope.launch {
            try {
                val title = app.apiClient.saveUrl(shared)
                Toast.makeText(applicationContext, "Saved: $title", Toast.LENGTH_LONG).show()
                runCatching { app.repository.syncNow() } // pull it into the list
            } catch (e: Exception) {
                Toast.makeText(applicationContext, "Couldn't save: ${e.message ?: "error"}", Toast.LENGTH_LONG).show()
            } finally {
                finish()
            }
        }
    }

    private fun importAudio(app: ReadLaterApp, uri: Uri, titleHint: String?) {
        val (name, declaredSize) = describe(uri)
        if (declaredSize > MAX_AUDIO_BYTES) {
            tooBig(declaredSize)
            return
        }
        // Named up front: an episode is tens of MB, so this is the one share that
        // visibly takes a while, and a silent pause reads as nothing happening.
        Toast.makeText(
            applicationContext,
            if (declaredSize > 0) "Sending episode to Earmark (${declaredSize / 1024 / 1024} MB)…"
            else "Sending episode to Earmark…",
            Toast.LENGTH_LONG
        ).show()
        lifecycleScope.launch {
            var spool: File? = null
            try {
                // Copy out of the sending app before uploading, rather than
                // streaming the upload straight from its content:// URI. Pocket
                // Casts serves a downloaded episode from a background job, and
                // holding that open for the length of a mobile upload is long
                // enough for the job to give up ("job timed out") even though the
                // bytes reached us. A local copy takes seconds; the upload then
                // reads from our own file, which also makes an OkHttp retry free.
                spool = withContext(Dispatchers.IO) { copyToCache(uri) }
                val size = spool.length()
                if (size > MAX_AUDIO_BYTES) { tooBig(size); return@launch }
                val title = app.apiClient.importAudio(uploadName(name, titleHint), size) {
                    spool.inputStream()
                }
                Toast.makeText(applicationContext, "Transcribing: $title", Toast.LENGTH_LONG).show()
                runCatching { app.repository.syncNow() } // the stub shows up in the list
            } catch (e: Exception) {
                Toast.makeText(applicationContext, "Couldn't send: ${e.message ?: "error"}", Toast.LENGTH_LONG).show()
            } finally {
                spool?.delete()
                finish()
            }
        }
    }

    private fun tooBig(size: Long) {
        Toast.makeText(
            applicationContext,
            "That episode is ${size / 1024 / 1024} MB — too big to send (limit 100 MB)",
            Toast.LENGTH_LONG
        ).show()
        finish()
    }

    /** Spool the share into our own cache. Deleted as soon as the upload ends,
     *  either way. */
    private fun copyToCache(uri: Uri): File {
        val spool = File.createTempFile("share-upload", ".tmp", cacheDir)
        try {
            val input = contentResolver.openInputStream(uri)
                ?: throw IOException("could not read the shared file")
            input.use { source -> spool.outputStream().use { source.copyTo(it, 64 * 1024) } }
        } catch (e: Throwable) {
            spool.delete()
            throw e
        }
        return spool
    }

    /**
     * What to call the upload. The server titles the article after this, minus
     * the extension, so a bare episode id is worth replacing with the title the
     * player sent alongside it. The extension is kept from the real filename —
     * the server sniffs the format from the bytes, but the suffix is what the
     * title strip keys on.
     */
    private fun uploadName(filename: String, titleHint: String?): String {
        val fallback = filename.ifBlank { "Podcast episode.mp3" }
        val ext = filename.substringAfterLast('.', "").takeIf { it.length in 1..5 } ?: "mp3"
        val stem = filename.substringBeforeLast('.', filename)
        if (titleHint == null || (stem.isNotBlank() && !OPAQUE_NAME.matches(stem))) return fallback
        // Only path separators are stripped. Dots stay: the server drops one
        // trailing extension, so "Ep. 42: The Thing.mp3" keeps its full title.
        val clean = titleHint.replace(Regex("[/\\\\]+"), " ").trim().ifBlank { return fallback }
        return "$clean.$ext"
    }

    /** Display name and byte length of a shared URI. The length is -1 when the
     *  provider won't say, in which case the copy below settles it. */
    private fun describe(uri: Uri): Pair<String, Long> {
        var name = ""
        var size = -1L
        runCatching {
            contentResolver.query(uri, null, null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        .takeIf { it >= 0 && !c.isNull(it) }
                        ?.let { name = c.getString(it).orEmpty() }
                    c.getColumnIndex(OpenableColumns.SIZE)
                        .takeIf { it >= 0 && !c.isNull(it) }
                        ?.let { size = c.getLong(it) }
                }
            }
        }
        if (name.isBlank()) name = uri.lastPathSegment?.substringAfterLast('/').orEmpty()
        return name to size // may be blank; uploadName settles on a fallback
    }
}
