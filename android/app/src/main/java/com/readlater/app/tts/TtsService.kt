package com.readlater.app.tts

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import com.readlater.app.MainActivity
import com.readlater.app.R
import com.readlater.app.ReadLaterApp
import com.readlater.app.data.Block
import com.readlater.app.data.HtmlParser
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Playback state published for the UI (ReaderScreen observes this). */
data class TtsPlaybackState(
    val articleId: String? = null,
    val paragraphIndex: Int = 0,
    val isPlaying: Boolean = false
)

/**
 * Foreground (started, not bound) service that reads an article aloud paragraph
 * by paragraph, keeps a partial wake lock so playback survives the screen turning
 * off, and exposes media controls through a MediaSession-styled notification.
 */
class TtsService : Service() {

    companion object {
        const val ACTION_PLAY = "com.readlater.app.tts.action.PLAY"
        const val ACTION_PAUSE = "com.readlater.app.tts.action.PAUSE"
        const val ACTION_RESUME = "com.readlater.app.tts.action.RESUME"
        const val ACTION_NEXT = "com.readlater.app.tts.action.NEXT"
        const val ACTION_PREV = "com.readlater.app.tts.action.PREV"
        const val ACTION_STOP = "com.readlater.app.tts.action.STOP"

        const val EXTRA_ARTICLE_ID = "articleId"
        const val EXTRA_START_PARAGRAPH = "startParagraph"

        private const val CHANNEL_ID = "tts_playback"
        private const val NOTIFICATION_ID = 1001

        /** Current playback state, observable from anywhere. */
        val stateFlow = MutableStateFlow(TtsPlaybackState())
    }

    private val app get() = application as ReadLaterApp
    private val mainHandler = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var mediaSession: MediaSessionCompat? = null
    private var wakeLock: PowerManager.WakeLock? = null

    private var articleId: String? = null
    private var articleTitle = ""
    private var articleSite = ""
    private var blocks: List<Block> = emptyList()
    private var currentIndex = 0
    private var isPlaying = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        mediaSession = MediaSessionCompat(this, "ReadLaterTts").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() = handleResume()
                override fun onPause() = handlePause()
                override fun onSkipToNext() = handleNext()
                override fun onSkipToPrevious() = handlePrev()
                override fun onStop() = handleStop()
            })
            isActive = true
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PLAY -> handlePlay(intent)
            ACTION_PAUSE -> handlePause()
            ACTION_RESUME -> handleResume()
            ACTION_NEXT -> handleNext()
            ACTION_PREV -> handlePrev()
            ACTION_STOP -> handleStop()
            else -> if (articleId == null) stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        stateFlow.value = TtsPlaybackState()
        releaseWakeLock()
        tts?.stop()
        tts?.shutdown()
        tts = null
        ttsReady = false
        mediaSession?.release()
        mediaSession = null
        scope.cancel()
        super.onDestroy()
    }

    // ------------------------------------------------------------------ actions

    private fun handlePlay(intent: Intent) {
        val requestedId = intent.getStringExtra(EXTRA_ARTICLE_ID) ?: articleId
        val startParagraph = intent.getIntExtra(EXTRA_START_PARAGRAPH, -1)
        if (requestedId == null) {
            stopSelf()
            return
        }
        // Go foreground immediately: startForegroundService() requires it quickly.
        startInForeground()
        scope.launch {
            val article = withContext(Dispatchers.IO) {
                app.database.articleDao().getById(requestedId)
            }
            val html = article?.html
            if (article == null || html.isNullOrBlank()) {
                handleStop()
                return@launch
            }
            articleId = article.id
            articleTitle = article.title
            articleSite = article.siteName.orEmpty()
            blocks = HtmlParser.parse(html)
            if (blocks.isEmpty()) {
                handleStop()
                return@launch
            }
            currentIndex = (if (startParagraph >= 0) startParagraph else article.readParagraph)
                .coerceIn(0, blocks.size - 1)
            isPlaying = true
            updateMetadata()
            acquireWakeLock()
            if (ttsReady) speakCurrent() else initTts()
        }
    }

    private fun handlePause() {
        if (articleId == null) {
            stopSelf()
            return
        }
        if (!isPlaying) return
        isPlaying = false
        tts?.stop()
        releaseWakeLock()
        publishState()
        updatePlaybackState()
        updateNotification()
    }

    private fun handleResume() {
        if (articleId == null) {
            stopSelf()
            return
        }
        if (isPlaying) return
        isPlaying = true
        acquireWakeLock()
        publishState()
        updatePlaybackState()
        if (ttsReady) speakCurrent() else initTts()
    }

    private fun handleNext() {
        if (articleId == null) {
            stopSelf()
            return
        }
        val next = nextSpeakable(currentIndex + 1) ?: return
        currentIndex = next
        articleId?.let { app.repository.saveReadPosition(it, next) }
        if (isPlaying) speakCurrent() else {
            publishState()
            updateNotification()
        }
    }

    private fun handlePrev() {
        if (articleId == null) {
            stopSelf()
            return
        }
        val prev = prevSpeakable(currentIndex - 1) ?: return
        currentIndex = prev
        articleId?.let { app.repository.saveReadPosition(it, prev) }
        if (isPlaying) speakCurrent() else {
            publishState()
            updateNotification()
        }
    }

    private fun handleStop() {
        isPlaying = false
        tts?.stop()
        releaseWakeLock()
        stateFlow.value = TtsPlaybackState()
        updatePlaybackState()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    // ------------------------------------------------------------------ speech

    private fun initTts() {
        if (tts != null) return
        tts = TextToSpeech(this) { status ->
            mainHandler.post {
                if (status == TextToSpeech.SUCCESS) {
                    ttsReady = true
                    tts?.setOnUtteranceProgressListener(utteranceListener)
                    if (isPlaying) speakCurrent()
                } else {
                    handleStop()
                }
            }
        }
    }

    private val utteranceListener = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) = Unit

        override fun onDone(utteranceId: String?) {
            mainHandler.post {
                if (!isPlaying) return@post
                val finished = utteranceId?.toIntOrNull() ?: return@post
                if (finished != currentIndex) return@post
                advanceAndSpeak()
            }
        }

        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) {
            mainHandler.post {
                if (isPlaying) advanceAndSpeak()
            }
        }
    }

    private fun advanceAndSpeak() {
        val next = nextSpeakable(currentIndex + 1)
        if (next == null) {
            // Finished the article.
            articleId?.let { app.repository.saveReadPosition(it, blocks.size - 1) }
            handleStop()
        } else {
            currentIndex = next
            articleId?.let { app.repository.saveReadPosition(it, next) }
            speakCurrent()
        }
    }

    private fun speakCurrent() {
        val engine = tts
        if (engine == null || !ttsReady) {
            initTts()
            return
        }
        val idx = nextSpeakable(currentIndex)
        if (idx == null) {
            handleStop()
            return
        }
        currentIndex = idx
        val text = speakableText(blocks[idx]) ?: run {
            handleStop()
            return
        }
        engine.setSpeechRate(app.settings.ttsSpeechRate)
        engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, idx.toString())
        publishState()
        updatePlaybackState()
        updateNotification()
    }

    private fun speakableText(block: Block): String? = when (block) {
        is Block.Paragraph -> block.text
        is Block.Heading -> block.text
        is Block.Quote -> block.text
        is Block.ImageBlock -> null
    }

    private fun nextSpeakable(from: Int): Int? {
        var i = from.coerceAtLeast(0)
        while (i < blocks.size) {
            if (speakableText(blocks[i]) != null) return i
            i++
        }
        return null
    }

    private fun prevSpeakable(from: Int): Int? {
        var i = from.coerceAtMost(blocks.size - 1)
        while (i >= 0) {
            if (speakableText(blocks[i]) != null) return i
            i--
        }
        return null
    }

    // ------------------------------------------------------------------ state

    private fun publishState() {
        stateFlow.value = TtsPlaybackState(articleId, currentIndex, isPlaying)
    }

    private fun updatePlaybackState() {
        val actions = PlaybackStateCompat.ACTION_PLAY or
            PlaybackStateCompat.ACTION_PAUSE or
            PlaybackStateCompat.ACTION_PLAY_PAUSE or
            PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
            PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
            PlaybackStateCompat.ACTION_STOP
        val state = if (isPlaying) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
        mediaSession?.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setActions(actions)
                .setState(state, PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1.0f)
                .build()
        )
    }

    private fun updateMetadata() {
        mediaSession?.setMetadata(
            MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, articleTitle)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, articleSite)
                .build()
        )
    }

    // ------------------------------------------------------------------ wake lock

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ReadLater::TtsWakeLock").apply {
            setReferenceCounted(false)
            acquire(6 * 60 * 60 * 1000L) // safety cap: 6 hours
        }
    }

    private fun releaseWakeLock() {
        if (wakeLock?.isHeld == true) {
            wakeLock?.release()
        }
        wakeLock = null
    }

    // ------------------------------------------------------------------ notification

    private fun createChannel() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Read aloud", NotificationManager.IMPORTANCE_LOW)
        )
    }

    private fun startInForeground() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun updateNotification() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, buildNotification())
    }

    private fun servicePendingIntent(action: String): PendingIntent =
        PendingIntent.getService(
            this,
            action.hashCode(),
            Intent(this, TtsService::class.java).setAction(action),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

    private fun buildNotification(): Notification {
        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val playPause = if (isPlaying) {
            NotificationCompat.Action(
                android.R.drawable.ic_media_pause, "Pause", servicePendingIntent(ACTION_PAUSE)
            )
        } else {
            NotificationCompat.Action(
                android.R.drawable.ic_media_play, "Play", servicePendingIntent(ACTION_RESUME)
            )
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(articleTitle.ifBlank { "ReadLater" })
            .setContentText(articleSite.ifBlank { "Reading aloud" })
            .setContentIntent(contentIntent)
            .setOnlyAlertOnce(true)
            .setOngoing(isPlaying)
            .addAction(
                NotificationCompat.Action(
                    android.R.drawable.ic_media_previous, "Previous", servicePendingIntent(ACTION_PREV)
                )
            )
            .addAction(playPause)
            .addAction(
                NotificationCompat.Action(
                    android.R.drawable.ic_media_next, "Next", servicePendingIntent(ACTION_NEXT)
                )
            )
            .addAction(
                NotificationCompat.Action(
                    android.R.drawable.ic_menu_close_clear_cancel, "Stop", servicePendingIntent(ACTION_STOP)
                )
            )
            .setStyle(
                androidx.media.app.NotificationCompat.MediaStyle()
                    .setMediaSession(mediaSession?.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2)
            )
            .build()
    }
}
