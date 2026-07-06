package com.readlater.app.tts

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.view.KeyEvent
import android.widget.Toast
import androidx.core.app.NotificationCompat
import androidx.media.session.MediaButtonReceiver
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
        const val ACTION_SET_POSITION = "com.readlater.app.tts.action.SET_POSITION"

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

    /** Estimated speech duration of each block at the current rate (ms). */
    private var blockDurationsMs: LongArray = LongArray(0)
    private var totalDurationMs = 0L

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

                // Lock-screen seekbar drag → jump to the matching paragraph.
                override fun onSeekTo(pos: Long) {
                    if (blocks.isEmpty()) return
                    var acc = 0L
                    var idx = 0
                    for (i in blockDurationsMs.indices) {
                        if (acc + blockDurationsMs[i] > pos) { idx = i; break }
                        acc += blockDurationsMs[i]
                        idx = i
                    }
                    currentIndex = nextSpeakable(idx) ?: return
                    articleId?.let { app.repository.saveTtsPositionLocal(it, currentIndex) }
                    if (isPlaying) speakCurrent() else {
                        discardPlayer()
                        publishState()
                        updatePlaybackState()
                        updateNotification()
                    }
                }

                // Headset buttons: 1 click play/pause, 2 clicks forward ~30s,
                // 3 clicks highlight the paragraph being read. Wired headsets
                // send HEADSETHOOK/PLAY_PAUSE clicks we count ourselves; most
                // Bluetooth earbuds translate multi-taps into NEXT/PREVIOUS,
                // so those are mapped to the same actions.
                override fun onMediaButtonEvent(mediaButtonEvent: Intent): Boolean {
                    @Suppress("DEPRECATION")
                    val event: KeyEvent? = if (Build.VERSION.SDK_INT >= 33) {
                        mediaButtonEvent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
                    } else {
                        mediaButtonEvent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
                    }
                    if (event != null) {
                        when (event.keyCode) {
                            KeyEvent.KEYCODE_HEADSETHOOK,
                            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> {
                                if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
                                    registerHeadsetClick()
                                }
                                return true
                            }
                            KeyEvent.KEYCODE_MEDIA_NEXT -> {
                                if (event.action == KeyEvent.ACTION_DOWN) handleForward30()
                                return true
                            }
                            KeyEvent.KEYCODE_MEDIA_PREVIOUS -> {
                                if (event.action == KeyEvent.ACTION_DOWN) handleHighlightCurrent()
                                return true
                            }
                            // Some headsets send distinct PLAY / PAUSE codes
                            // instead of PLAY_PAUSE — act on them immediately.
                            KeyEvent.KEYCODE_MEDIA_PLAY -> {
                                if (event.action == KeyEvent.ACTION_DOWN) handleResume()
                                return true
                            }
                            KeyEvent.KEYCODE_MEDIA_PAUSE -> {
                                if (event.action == KeyEvent.ACTION_DOWN) handlePause()
                                return true
                            }
                        }
                    }
                    return super.onMediaButtonEvent(mediaButtonEvent)
                }
            })
            // Route media buttons here even while paused (paused sessions
            // otherwise lose routing to whatever app played music last).
            setMediaButtonReceiver(
                PendingIntent.getBroadcast(
                    this@TtsService,
                    0,
                    Intent(Intent.ACTION_MEDIA_BUTTON).setClass(this@TtsService, MediaButtonReceiver::class.java),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
            )
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
            ACTION_SET_POSITION -> handleSetPosition(intent)
            // System-delivered media buttons (MediaButtonReceiver in the
            // manifest) route into the session callback.
            Intent.ACTION_MEDIA_BUTTON -> MediaButtonReceiver.handleIntent(mediaSession, intent)
            else -> if (articleId == null) stopSelf()
        }
        return START_NOT_STICKY
    }

    // -------------------------------------------------------- audio focus
    // Holding audio focus is what makes Android treat us as the current
    // media app — without it, headset buttons keep routing to whatever
    // played music last.
    private var focusRequest: AudioFocusRequest? = null
    private var pausedByFocusLoss = false

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        mainHandler.post {
            when (change) {
                AudioManager.AUDIOFOCUS_LOSS,
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                    if (isPlaying) {
                        pausedByFocusLoss = true
                        handlePause()
                    }
                }
                AudioManager.AUDIOFOCUS_GAIN -> {
                    if (pausedByFocusLoss && !isPlaying) {
                        pausedByFocusLoss = false
                        handleResume()
                    }
                }
            }
        }
    }

    private val playbackAudioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

    private fun requestAudioFocus() {
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        if (focusRequest == null) {
            focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(playbackAudioAttributes)
                .setOnAudioFocusChangeListener(focusListener)
                .build()
        }
        am.requestAudioFocus(focusRequest!!)
    }

    private fun abandonAudioFocus() {
        focusRequest?.let {
            val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            am.abandonAudioFocusRequest(it)
        }
        pausedByFocusLoss = false
    }

    override fun onDestroy() {
        stateFlow.value = TtsPlaybackState()
        releaseWakeLock()
        abandonAudioFocus()
        clearSynthCache()
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
            // Default resume point: the listening position, falling back to the
            // scroll position for articles never played before.
            val resumeAt = if (article.ttsParagraph > 0) article.ttsParagraph else article.readParagraph
            currentIndex = (if (startParagraph >= 0) startParagraph else resumeAt)
                .coerceIn(0, blocks.size - 1)
            isPlaying = true
            clearSynthCache() // article or rate may have changed; drop stale audio
            recomputeDurations()
            updateMetadata()
            acquireWakeLock()
            requestAudioFocus()
            initTts() // re-checks the preferred engine; no-op when unchanged
        if (ttsReady) speakCurrent()
        }
    }

    private fun handlePause() {
        if (articleId == null) {
            stopSelf()
            return
        }
        if (!isPlaying) return
        isPlaying = false
        // Pause mid-paragraph; resume continues from the same spot.
        if (player?.isPlaying == true) {
            player?.pause()
            pausedInParagraph = true
        }
        releaseWakeLock()
        // Pushing save: sync the paused position to the server right away.
        articleId?.let { app.repository.saveTtsPosition(it, currentIndex) }
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
        requestAudioFocus()
        publishState()
        updatePlaybackState()
        updateNotification()
        // Resume mid-paragraph when possible; otherwise re-speak from the
        // current paragraph (initTts also re-checks the preferred engine).
        if (pausedInParagraph && player != null) {
            pausedInParagraph = false
            player?.start()
            return
        }
        initTts()
        if (ttsReady) speakCurrent()
    }

    private fun handleNext() {
        if (articleId == null) {
            stopSelf()
            return
        }
        val next = nextSpeakable(currentIndex + 1) ?: return
        currentIndex = next
        articleId?.let { app.repository.saveTtsPositionLocal(it, next) }
        if (isPlaying) speakCurrent() else {
            discardPlayer()
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
        articleId?.let { app.repository.saveTtsPositionLocal(it, prev) }
        if (isPlaying) speakCurrent() else {
            discardPlayer()
            publishState()
            updateNotification()
        }
    }

    // -------------------------------------------------------- progress timeline

    /** Estimate per-block speech durations so the media session can expose a
     *  seekable timeline (lock-screen progress bar). */
    private fun recomputeDurations() {
        val rate = app.settings.ttsSpeechRate
        blockDurationsMs = LongArray(blocks.size) { i ->
            val len = speakableText(blocks[i])?.length ?: 0
            (len / (baseCharsPerSecond * rate) * 1000).toLong()
        }
        totalDurationMs = blockDurationsMs.sum()
    }

    private fun positionMs(index: Int): Long {
        var acc = 0L
        for (i in 0 until index.coerceIn(0, blockDurationsMs.size)) acc += blockDurationsMs[i]
        return acc
    }

    // -------------------------------------------------------- headset clicks

    /** Estimated characters spoken per second at 1.0× rate (≈180 wpm). */
    private val baseCharsPerSecond = 15f
    private var headsetClickCount = 0
    private val headsetClickRunnable = Runnable {
        when (headsetClickCount) {
            1 -> if (isPlaying) handlePause() else handleResume()
            2 -> handleForward30()
            else -> if (headsetClickCount >= 3) handleHighlightCurrent()
        }
        headsetClickCount = 0
    }

    private fun registerHeadsetClick() {
        headsetClickCount++
        mainHandler.removeCallbacks(headsetClickRunnable)
        if (headsetClickCount >= 3) headsetClickRunnable.run()
        else mainHandler.postDelayed(headsetClickRunnable, 600)
    }

    /** Skip forward by roughly 30 seconds of estimated speech, paragraph-granular. */
    private fun handleForward30() {
        if (articleId == null || blocks.isEmpty()) return
        var remaining = 30f * baseCharsPerSecond * app.settings.ttsSpeechRate
        var idx = currentIndex
        while (true) {
            remaining -= (blocks.getOrNull(idx)?.let { speakableText(it) }?.length ?: 0)
            val next = nextSpeakable(idx + 1) ?: break
            idx = next
            if (remaining <= 0) break
        }
        if (idx != currentIndex) {
            currentIndex = idx
            articleId?.let { app.repository.saveTtsPositionLocal(it, idx) }
            if (isPlaying) speakCurrent() else {
                publishState()
                updateNotification()
            }
        }
    }

    /** Save the currently spoken paragraph as a highlight (triple headset click). */
    private fun handleHighlightCurrent() {
        val id = articleId ?: return
        val text = blocks.getOrNull(currentIndex)?.let { speakableText(it) } ?: return
        app.repository.addHighlight(id, text, null, currentIndex)
        Toast.makeText(this, "Paragraph highlighted", Toast.LENGTH_SHORT).show()
    }

    /** Move the listening position without changing play/pause state —
     *  works while playing (re-speaks from there), paused, or idle. */
    private fun handleSetPosition(intent: Intent) {
        val requested = intent.getIntExtra(EXTRA_START_PARAGRAPH, -1)
        if (requested < 0 || blocks.isEmpty() || articleId == null) return
        currentIndex = nextSpeakable(requested.coerceIn(0, blocks.size - 1)) ?: return
        articleId?.let { app.repository.saveTtsPosition(it, currentIndex) }
        if (isPlaying) speakCurrent() else {
            discardPlayer() // paused mid-paragraph audio is now stale
            publishState()
            updatePlaybackState()
            updateNotification()
        }
    }

    private fun handleStop() {
        isPlaying = false
        tts?.stop()
        clearSynthCache()
        releaseWakeLock()
        abandonAudioFocus()
        // Pushing save: sync the final position to the server on the way out.
        articleId?.let { app.repository.saveTtsPosition(it, currentIndex) }
        stateFlow.value = TtsPlaybackState()
        updatePlaybackState()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    // ------------------------------------------------------------------ speech

    /** Neural Piper voices (sherpa-onnx engine) — preferred when installed. */
    private val sherpaEngine = "com.k2fsa.sherpa.onnx.tts.engine"
    private var initializedEngine: String? = null

    private fun isEngineInstalled(pkg: String): Boolean =
        runCatching { packageManager.getPackageInfo(pkg, 0) }.isSuccess

    private fun initTts() {
        val chosen = app.settings.ttsEngine
        val preferred = when {
            chosen.isNotBlank() && isEngineInstalled(chosen) -> chosen
            chosen.isBlank() && isEngineInstalled(sherpaEngine) -> sherpaEngine
            else -> null
        }
        // Re-init when the preferred engine changed (e.g. sherpa was installed
        // or the user picked a different engine while this service was alive).
        if (tts != null && preferred != initializedEngine) {
            tts?.stop()
            tts?.shutdown()
            tts = null
            ttsReady = false
        }
        if (tts != null) return
        initializedEngine = preferred
        initTtsWith(preferred)
    }

    private fun initTtsWith(engine: String?) {
        val listener = TextToSpeech.OnInitListener { status ->
            mainHandler.post {
                if (status == TextToSpeech.SUCCESS) {
                    ttsReady = true
                    tts?.setAudioAttributes(playbackAudioAttributes)
                    tts?.setOnUtteranceProgressListener(utteranceListener)
                    tts?.let(::pickBestVoice)
                    if (isPlaying) speakCurrent()
                } else if (engine != null) {
                    // preferred engine failed to initialize — fall back to default
                    tts = null
                    initializedEngine = null
                    initTtsWith(null)
                } else {
                    handleStop()
                }
            }
        }
        tts = if (engine != null) TextToSpeech(this, listener, engine) else TextToSpeech(this, listener)
    }

    /**
     * Apply the user's chosen voice when set and available; otherwise upgrade
     * to the highest-quality installed voice for the current language
     * (ties broken in favor of offline voices, so playback survives dead spots).
     */
    private fun pickBestVoice(engine: TextToSpeech) {
        val wanted = app.settings.ttsVoice
        if (wanted.isNotBlank()) {
            val match = runCatching { engine.voices?.firstOrNull { it.name == wanted } }.getOrNull()
            if (match != null) {
                engine.voice = match
                return
            }
        }
        try {
            val current = engine.voice ?: return
            val language = current.locale?.language ?: return
            val best = engine.voices
                ?.filter {
                    it.locale.language == language &&
                        !it.features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)
                }
                ?.maxWithOrNull(
                    compareBy({ it.quality }, { if (it.isNetworkConnectionRequired) 0 else 1 })
                ) ?: return
            if (best.quality > current.quality) engine.voice = best
        } catch (_: Exception) {
            // Some engines throw from getVoices(); keep the default voice.
        }
    }

    // The TTS engine only SYNTHESIZES; playback happens through a MediaPlayer
    // in OUR process. Crucial for headset controls: Android routes media
    // buttons to the app that owns the audio playback, and audio played by
    // the engine's process (the default speak() path) credits the engine,
    // not us — so buttons kept going to whatever music app played last.
    private var player: MediaPlayer? = null
    private val readyFiles = mutableSetOf<Int>()
    private val synthesizing = mutableSetOf<Int>()
    private var awaitingPlayIndex = -1
    private var pausedInParagraph = false

    private fun synthFile(idx: Int) = java.io.File(cacheDir, "tts-$idx.wav")

    private fun discardPlayer() {
        pausedInParagraph = false
        player?.release()
        player = null
    }

    private fun clearSynthCache() {
        discardPlayer()
        readyFiles.clear()
        synthesizing.clear()
        awaitingPlayIndex = -1
        cacheDir.listFiles()?.filter { it.name.startsWith("tts-") }?.forEach { it.delete() }
    }

    private val utteranceListener = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) = Unit

        override fun onDone(utteranceId: String?) {
            mainHandler.post {
                val idx = utteranceId?.removePrefix("synth-")?.toIntOrNull() ?: return@post
                synthesizing.remove(idx)
                readyFiles.add(idx)
                if (idx == awaitingPlayIndex && isPlaying) {
                    awaitingPlayIndex = -1
                    startPlayback(idx)
                }
            }
        }

        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) {
            mainHandler.post {
                val idx = utteranceId?.removePrefix("synth-")?.toIntOrNull() ?: return@post
                synthesizing.remove(idx)
                if (idx == awaitingPlayIndex && isPlaying) {
                    awaitingPlayIndex = -1
                    currentIndex = idx
                    advanceAndSpeak()
                }
            }
        }
    }

    private fun advanceAndSpeak() {
        val next = nextSpeakable(currentIndex + 1)
        if (next == null) {
            // Finished the article; handleStop pushes the final position.
            currentIndex = blocks.size - 1
            handleStop()
        } else {
            currentIndex = next
            articleId?.let { app.repository.saveTtsPositionLocal(it, next) }
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
        pausedInParagraph = false
        publishState()
        updatePlaybackState()
        updateNotification()
        if (readyFiles.contains(idx) && synthFile(idx).exists()) {
            startPlayback(idx)
        } else {
            awaitingPlayIndex = idx
            synthesize(idx)
        }
    }

    private fun synthesize(idx: Int) {
        // Never double-request: a second synthesizeToFile for the same path
        // while the first is still running corrupts the output (this is why
        // slower neural engines stopped after one paragraph).
        if (synthesizing.contains(idx) || readyFiles.contains(idx)) return
        val engine = tts ?: return
        val text = blocks.getOrNull(idx)?.let { speakableText(it) } ?: return
        synthesizing.add(idx)
        engine.setSpeechRate(app.settings.ttsSpeechRate)
        engine.synthesizeToFile(text, Bundle(), synthFile(idx), "synth-$idx")
    }

    private fun startPlayback(idx: Int) {
        player?.release()
        player = MediaPlayer().apply {
            setAudioAttributes(playbackAudioAttributes)
            setDataSource(synthFile(idx).path)
            setOnPreparedListener {
                if (isPlaying) it.start() else pausedInParagraph = true
                // synthesize the next paragraph while this one plays
                nextSpeakable(idx + 1)?.let { n ->
                    if (!readyFiles.contains(n) && n != awaitingPlayIndex) synthesize(n)
                }
            }
            setOnCompletionListener {
                synthFile(idx).delete()
                readyFiles.remove(idx)
                if (isPlaying) advanceAndSpeak()
            }
            setOnErrorListener { _, _, _ ->
                if (isPlaying) advanceAndSpeak()
                true
            }
            prepareAsync()
        }
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
            PlaybackStateCompat.ACTION_SEEK_TO or
            PlaybackStateCompat.ACTION_STOP
        val state = if (isPlaying) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
        // Estimated position drives the lock-screen progress bar; speed 1.0
        // lets the system advance it smoothly between paragraph updates.
        mediaSession?.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setActions(actions)
                .setState(state, positionMs(currentIndex), if (isPlaying) 1.0f else 0f)
                .build()
        )
    }

    private fun updateMetadata() {
        mediaSession?.setMetadata(
            MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, articleTitle)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, articleSite)
                .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, totalDurationMs)
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
        val pct = if (totalDurationMs > 0) (positionMs(currentIndex) * 100 / totalDurationMs).toInt() else 0
        val progressText = if (blocks.isNotEmpty()) {
            "$pct% · ${articleSite.ifBlank { "Reading aloud" }}"
        } else articleSite.ifBlank { "Reading aloud" }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(articleTitle.ifBlank { "ReadLater" })
            .setContentText(progressText)
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
