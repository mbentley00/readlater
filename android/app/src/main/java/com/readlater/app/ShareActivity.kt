package com.readlater.app

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

/**
 * Handles "share to Earmark" without ever showing the app. Uses a translucent,
 * no-history theme, so from the user's point of view the share sheet just
 * dismisses and a toast confirms the save.
 *
 * Two kinds of share arrive here:
 *  - a link (text/plain), saved as an article the usual way;
 *  - an audio file, which is a podcast episode shared out of a player. That is
 *    handed to [ShareUploadService], which sends it to /api/import/audio to be
 *    transcribed. A player's *link* to an episode is not enough — nothing on the
 *    server resolves a podcast URL to its audio — so the file is the whole
 *    mechanism.
 *
 * Completion toasts use the application context so they still appear after
 * finish().
 */
class ShareActivity : ComponentActivity() {

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
            // The upload outlives this activity; see ShareUploadService for why.
            ShareUploadService.start(this, stream, send.type, send.titleHint())
            finish()
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
}
