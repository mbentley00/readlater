package com.readlater.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.provider.OpenableColumns
import android.widget.Toast
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.readlater.app.data.PodcastFiles
import com.readlater.app.data.RemoteArticle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException

/**
 * Uploads a podcast episode shared to Earmark.
 *
 * This used to run on the share activity's lifecycleScope. That activity is
 * noHistory, so the moment the user went back to their player it was finished
 * and its scope cancelled — but OkHttp's blocking call isn't interruptible, so
 * the upload carried on and landed, and only then did the cancellation surface,
 * as an error toast about an episode that was already transcribing. A foreground
 * service outlives the activity, and keeps the process from being frozen as a
 * cached app halfway through a long upload.
 *
 * Once the upload lands the service stays up until the transcript does, polling
 * the article, and then posts a notification that opens it. The server has no
 * way to push to the phone, and the episode is no use until it's transcribed,
 * so "it's ready" is the notification worth having.
 */
class ShareUploadService : Service() {

    companion object {
        private const val CHANNEL_ID = "uploads"
        private const val NOTIFICATION_ID = 2
        /** Separate from [CHANNEL_ID] so "ready" can make a sound while the
         *  ongoing progress notification stays silent. */
        private const val READY_CHANNEL_ID = "transcripts"
        private const val EXTRA_TITLE_HINT = "titleHint"

        /** How often to check on a transcription, and when to stop. A long
         *  episode takes a few minutes, but the server transcribes one at a
         *  time, so a share can wait behind feed episodes. */
        private const val POLL_MS = 20_000L
        private const val POLL_LIMIT_MS = 2 * 60 * 60 * 1000L

        /** Matches AUDIO_IMPORT_MAX_BYTES on the server, which hangs up past it.
         *  Checked here so an oversized episode says so instead of failing at the
         *  end of a long upload. */
        const val MAX_AUDIO_BYTES = 100L * 1024 * 1024

        /** Pocket Casts names a downloaded episode after its episode id, so the
         *  filename alone would title the article `fb520208-cac4-…`. */
        val OPAQUE_NAME = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9a-f]{16,}$", RegexOption.IGNORE_CASE)

        /** Hand a shared episode over. The read grant on [uri] travels with the
         *  intent, so it outlives the share activity that received it. */
        fun start(context: Context, uri: Uri, type: String?, titleHint: String?) {
            val intent = Intent(context, ShareUploadService::class.java)
                .setDataAndType(uri, type)
                .putExtra(EXTRA_TITLE_HINT, titleHint)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            ContextCompat.startForegroundService(context, intent)
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var active = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Episode uploads", NotificationManager.IMPORTANCE_LOW)
        )
        nm.createNotificationChannel(
            NotificationChannel(READY_CHANNEL_ID, "Transcripts ready", NotificationManager.IMPORTANCE_DEFAULT)
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Must be foreground within seconds of startForegroundService, whatever follows.
        ServiceCompat.startForeground(
            this, NOTIFICATION_ID, progressNotification("Sending episode to ${getString(R.string.app_name)}"),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
        )
        val uri = intent?.data
        if (uri == null) {
            if (active == 0) stopNow()
            return START_NOT_STICKY
        }
        active++
        val titleHint = intent.getStringExtra(EXTRA_TITLE_HINT)
        scope.launch {
            try {
                upload(uri, titleHint)
            } finally {
                if (--active == 0) stopNow()
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun progressNotification(title: String) =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setProgress(0, 0, true)
            .setOngoing(true)
            .setSilent(true)
            .build()

    private fun showProgress(title: String) = runCatching {
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .notify(NOTIFICATION_ID, progressNotification(title))
    }

    /** The server's stub says "Transcribing…" until the transcript replaces it
     *  (server.js pumpStt), or "Transcription failed" if it couldn't. */
    private fun RemoteArticle.transcribing() = excerpt == "Transcribing…"
    private fun RemoteArticle.failed() = excerpt == "Transcription failed"

    /** Wait out the server's transcription of [first], then say it's ready.
     *  A network hiccup just means another try; a deleted article ends it. */
    private suspend fun awaitTranscript(app: ReadLaterApp, first: RemoteArticle) {
        var article = first
        val deadline = System.currentTimeMillis() + POLL_LIMIT_MS
        while (article.transcribing()) {
            if (System.currentTimeMillis() > deadline) {
                notifyDone(article, "Still transcribing", article.title)
                return
            }
            delay(POLL_MS)
            article = try {
                app.apiClient.getArticle(article.id)
            } catch (e: IOException) {
                if (e.message?.startsWith("Server error 404") == true) return
                continue
            }
        }
        runCatching { app.repository.syncNow() } // so the tap opens the transcript, not the stub
        notifyDone(
            article,
            if (article.failed()) "Transcription failed" else "Ready in ${getString(R.string.app_name)}",
            article.title,
        )
    }

    /** One notification per episode, tapping through to it. */
    private fun notifyDone(article: RemoteArticle, title: String, text: String) {
        val open = Intent(this, MainActivity::class.java)
            .putExtra(MainActivity.EXTRA_OPEN_ARTICLE, article.id)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val requestCode = article.id.hashCode()
        val notification = NotificationCompat.Builder(this, READY_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(
                PendingIntent.getActivity(
                    this, requestCode, open,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
            )
            .setAutoCancel(true)
            .build()
        // Notification permission denied: no notification, nothing else lost.
        runCatching {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(requestCode, notification)
        }
    }

    private fun stopNow() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun toast(text: String) =
        Toast.makeText(applicationContext, text, Toast.LENGTH_LONG).show()

    private suspend fun upload(uri: Uri, titleHint: String?) {
        val app = application as ReadLaterApp
        val (name, declaredSize) = describe(uri)
        if (declaredSize > MAX_AUDIO_BYTES) { tooBig(declaredSize); return }
        // Named up front: an episode is tens of MB, so this is the one share that
        // visibly takes a while, and a silent pause reads as nothing happening.
        toast(
            if (declaredSize > 0) "Sending episode to ${getString(R.string.app_name)} (${declaredSize / 1024 / 1024} MB)…"
            else "Sending episode to ${getString(R.string.app_name)}…"
        )
        var spool: File? = null
        var imported: RemoteArticle? = null
        try {
            // Copy out of the sending app before uploading, rather than
            // streaming the upload straight from its content:// URI. Pocket
            // Casts serves a downloaded episode from a background job, and
            // holding that open for the length of a mobile upload is long
            // enough for the job to give up ("job timed out") even though the
            // bytes reached us. A local copy takes seconds; the upload then
            // reads from our own file, which also makes an OkHttp retry free.
            val file = withContext(Dispatchers.IO) { copyToCache(uri) }
            spool = file
            val size = file.length()
            if (size > MAX_AUDIO_BYTES) { tooBig(size); return }
            val hash = withContext(Dispatchers.IO) { PodcastFiles.hashOf(file) }
            val article = try {
                app.apiClient.importAudio(uploadName(name, titleHint), size) { file.inputStream() }
            } finally {
                // Kept for playing the episode itself, whichever way the upload
                // went: a "failed" upload has often landed (below), and the file
                // finds its article by content hash once it syncs. One that
                // really failed is swept after a few days, or replaced by a re-share.
                withContext(Dispatchers.IO) {
                    runCatching { app.podcastFiles.keep(file, hash, audioExt(name)) }
                }
            }
            imported = article
            if (article.transcribing()) toast("Transcribing: ${article.title}")
            runCatching { app.repository.syncNow() } // the stub shows up in the list
        } catch (e: Exception) {
            // A genuine network failure can still come after the server has
            // the bytes (the connection dropping as the reply comes back), so
            // sync before reporting: the article turns up in the list instead
            // of seeming lost. Sharing again is safe regardless — the server
            // dedupes on the file's content hash.
            runCatching { app.repository.syncNow() }
            toast("Couldn't confirm: ${e.message ?: "error"} — check the list, it may have saved anyway")
        } finally {
            spool?.delete() // no-op once kept; clears a spool that never got that far
        }
        // Outside the try: cancelling the wait isn't an upload failure.
        imported?.let {
            if (it.transcribing()) showProgress("Transcribing: ${it.title}")
            awaitTranscript(app, it)
        }
    }

    /** Extension for the stored episode, from the shared filename. */
    private fun audioExt(filename: String): String =
        filename.substringAfterLast('.', "").lowercase().takeIf { it.length in 1..5 } ?: "mp3"

    private fun tooBig(size: Long) =
        toast("That episode is ${size / 1024 / 1024} MB — too big to send (limit 100 MB)")

    /** Spool the share into our own cache. Once the upload ends it is moved
     *  into [PodcastFiles] for playing (or deleted, if it never got that far). */
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
     * the extension, when the file carries no embedded title — so a bare episode
     * id is worth replacing with the title the player sent alongside it. The
     * extension is kept from the real filename.
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
     *  provider won't say, in which case the copy settles it. */
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
