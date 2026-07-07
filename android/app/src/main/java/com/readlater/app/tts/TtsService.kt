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

        /** How many upcoming paragraphs to keep synthesized ahead of playback. */
        private const val PREFETCH_AHEAD = 3

        /** Deliberate pause between paragraphs for the neural (Kaldi/sherpa)
         *  voice — its delivery runs paragraphs together, so a beat helps. */
        private const val KALDI_PARAGRAPH_GAP_MS = 500L

        /** Current playback state, observable from anywhere. */
        val stateFlow = MutableStateFlow(TtsPlaybackState())

        /** Rolling TTS event log shown under Settings → Voice diagnostics. */
        val debugLog = MutableStateFlow<List<String>>(emptyList())

        fun logDbg(msg: String) {
            val ts = java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.US)
                .format(java.util.Date())
            debugLog.value = (debugLog.value + "$ts $msg").takeLast(150)
        }
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
                    if (isPlaying) playFromCurrent() else {
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
                    if (event != null && isOurMediaKey(event.keyCode)) {
                        // Consume both DOWN and UP so the system doesn't also
                        // route the key to another media app; act on DOWN only,
                        // debounced against double-delivery (the cause of the
                        // "pause then resume" glitch on Bluetooth earbuds).
                        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
                            logDbg("media button keyCode=${event.keyCode}")
                            dispatchMediaKey(event.keyCode)
                        }
                        return true
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
            logDbg("audio focus change=$change")
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
        // Best-effort: persist the listening position if we're being torn down
        // mid-playback (repository scope is app-lived, so this survives us).
        if (isPlaying) articleId?.let { app.repository.saveTtsPosition(it, currentIndex) }
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
        logDbg("PLAY requested article=$requestedId start=$startParagraph")
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
            // Make this the cold-start resume target: if the process is killed
            // while listening, reopening returns to this article.
            app.settings.lastArticleId = article.id
            articleTitle = article.title
            articleSite = article.siteName.orEmpty()
            blocks = HtmlParser.parse(html)
            if (blocks.isEmpty()) {
                handleStop()
                return@launch
            }
            logDbg("loaded ${blocks.size} blocks, ${blocks.count { speakableText(it) != null }} speakable — ${article.title.take(40)}")
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
            speakableBlocks = blocks.indices.filter { speakableText(blocks[it]) != null }
            // Prefer the server (Kokoro) voice when enabled and available;
            // otherwise (incl. not-yet-generated) fall back to the device voice.
            if (app.settings.useServerVoice && tryStartServerVoice(article.id)) {
                return@launch
            }
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
        logDbg("PAUSE (idx=$currentIndex)")
        isPlaying = false
        playToken++          // invalidate any pending watchdog
        cancelAudioWatchdog()
        if (!usingSpeakFallback && audioTrack != null) {
            // remember the exact position so resume continues mid-sentence
            resumePositionMs = trackPositionMs()
            releasePlayer()
        } else {
            tts?.stop() // fallback speak(): position is lost, resume re-speaks
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
        logDbg("RESUME (idx=$currentIndex)")
        isPlaying = true
        acquireWakeLock()
        requestAudioFocus()
        publishState()
        updatePlaybackState()
        updateNotification()
        // Continue from the current sentence (initTts re-checks the engine).
        initTts()
        if (ttsReady) resumeSpeaking()
    }

    private fun handleNext() {
        if (articleId == null) {
            stopSelf()
            return
        }
        val next = nextSpeakable(currentIndex + 1) ?: return
        currentIndex = next
        articleId?.let { app.repository.saveTtsPositionLocal(it, next) }
        if (isPlaying) playFromCurrent() else {
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
        if (isPlaying) playFromCurrent() else {
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

    // -------------------------------------------------------- media buttons

    /** Estimated characters spoken per second at 1.0× rate (≈180 wpm). */
    private val baseCharsPerSecond = 15f

    private var lastButtonAt = 0L
    private val buttonDebounceMs = 500L

    private fun isOurMediaKey(code: Int) = code == KeyEvent.KEYCODE_HEADSETHOOK ||
        code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE ||
        code == KeyEvent.KEYCODE_MEDIA_PLAY ||
        code == KeyEvent.KEYCODE_MEDIA_PAUSE ||
        code == KeyEvent.KEYCODE_MEDIA_NEXT ||
        code == KeyEvent.KEYCODE_MEDIA_PREVIOUS

    /** Dispatch a media key with debounce so a single physical tap (which some
     *  Bluetooth earbuds deliver more than once) doesn't toggle twice. On the
     *  Pixel Buds a single tap is play/pause, double tap is NEXT (→ +30s), and
     *  triple tap is PREVIOUS (→ highlight). */
    private fun dispatchMediaKey(code: Int) {
        val now = android.os.SystemClock.elapsedRealtime()
        if (now - lastButtonAt < buttonDebounceMs) {
            logDbg("  (debounced $code)")
            return
        }
        lastButtonAt = now
        when (code) {
            KeyEvent.KEYCODE_HEADSETHOOK,
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> if (isPlaying) handlePause() else handleResume()
            KeyEvent.KEYCODE_MEDIA_PLAY -> if (!isPlaying) handleResume()
            KeyEvent.KEYCODE_MEDIA_PAUSE -> if (isPlaying) handlePause()
            KeyEvent.KEYCODE_MEDIA_NEXT -> handleForward30()
            KeyEvent.KEYCODE_MEDIA_PREVIOUS -> handleHighlightCurrent()
        }
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
            if (isPlaying) playFromCurrent() else {
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
        if (isPlaying) playFromCurrent() else {
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
        var preferred = when {
            chosen.isNotBlank() && isEngineInstalled(chosen) -> chosen
            chosen.isBlank() && isEngineInstalled(sherpaEngine) -> sherpaEngine
            else -> null
        }
        if (preferred != null && preferred == engineBlockedThisSession) preferred = null
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
        logDbg("initTts engine=${preferred ?: "system default"} (pref='${chosen}' blocked=${engineBlockedThisSession != null})")
        initTtsWith(preferred)
    }

    private var initGen = 0

    private fun initTtsWith(engine: String?) {
        val myGen = ++initGen
        logDbg("init engine=${engine ?: "system default"}")
        val listener = TextToSpeech.OnInitListener { status ->
            mainHandler.post {
                if (myGen != initGen) return@post // superseded (e.g. watchdog restarted init)
                if (status == TextToSpeech.SUCCESS) {
                    ttsReady = true
                    tts?.setAudioAttributes(playbackAudioAttributes)
                    tts?.setOnUtteranceProgressListener(utteranceListener)
                    tts?.let(::pickBestVoice)
                    logDbg("engine READY: ${initializedEngine ?: "system default"} voice=${runCatching { tts?.voice?.name }.getOrNull()}")
                    if (isPlaying) resumeSpeaking()
                } else if (engine != null) {
                    logDbg("engine INIT FAILED status=$status: $engine — falling back")
                    Toast.makeText(
                        this@TtsService,
                        "Voice engine failed to start — using the system voice",
                        Toast.LENGTH_LONG
                    ).show()
                    engineBlockedThisSession = engine
                    tts = null
                    initializedEngine = null
                    initTtsWith(null)
                } else {
                    logDbg("system engine init failed status=$status")
                    handleStop()
                }
            }
        }
        tts = if (engine != null) TextToSpeech(this, listener, engine) else TextToSpeech(this, listener)
        // Init watchdog: some engines never call onInit (hung model load) — that
        // looked like a dead play button. Fall back if init is silent for 8s.
        mainHandler.postDelayed({
            if (myGen == initGen && !ttsReady) {
                logDbg("INIT WATCHDOG: ${engine ?: "system"} never signalled init")
                if (engine != null) {
                    engineBlockedThisSession = engine
                    runCatching { tts?.shutdown() }
                    tts = null
                    initializedEngine = null
                    initTtsWith(null)
                } else {
                    Toast.makeText(this, "Text-to-speech isn't responding on this device", Toast.LENGTH_LONG).show()
                    handleStop()
                }
            }
        }, 8_000)
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

    // Playback: the engine SYNTHESIZES each paragraph to a WAV file; we read the
    // raw PCM and stream it to an AudioTrack in OUR process. MediaPlayer failed
    // here (the media service can't decode/route our private files), and — more
    // importantly — audio played by our process is what makes Android route the
    // headset media buttons to Earmark instead of the last music app. Pause/
    // resume seeks by byte offset for true mid-sentence resume. If a file can't
    // be parsed/played we fall back to speak() (audio works, buttons may not).
    private var audioTrack: android.media.AudioTrack? = null
    private var playThread: Thread? = null
    @Volatile private var playThreadGen = 0
    private var trackSampleRate = 22050
    private var trackChannels = 1
    private var trackStartMs = 0
    private var preparedIdx = -1
    private val readyFiles = mutableSetOf<Int>()
    private val synthesizing = mutableSetOf<Int>()
    private var awaitingIdx = -1
    private var awaitingFromMs = 0
    private var resumePositionMs = 0
    private var usingSpeakFallback = false
    private var fallbackToasted = false
    private var audioStarted = false
    private var playToken = 0

    private fun synthFile(idx: Int) = java.io.File(cacheDir, "tts-$idx.wav")

    // --- Server voice (Kokoro): one downloaded WAV for the whole article,
    // played continuously; playback time maps to app paragraphs via the
    // server's per-paragraph offsets so highlight/resume keep working.
    private var serverMode = false
    private var serverOffsetsMs = IntArray(0)
    private var speakableBlocks: List<Int> = emptyList() // app block indices that are speakable
    private fun serverWavFile(id: String) = java.io.File(cacheDir, "server-$id.wav")

    /** App block index playing at time [ms]. */
    private fun blockForMs(ms: Int): Int {
        if (serverOffsetsMs.isEmpty() || speakableBlocks.isEmpty()) return currentIndex
        var p = 0
        for (i in serverOffsetsMs.indices) { if (serverOffsetsMs[i] <= ms) p = i else break }
        return speakableBlocks.getOrElse(p) { speakableBlocks.last() }
    }

    /** Playback time (ms) at which app block [blockIdx] starts. */
    private fun msForBlock(blockIdx: Int): Int {
        if (serverOffsetsMs.isEmpty() || speakableBlocks.isEmpty()) return 0
        var p = speakableBlocks.indexOfFirst { it >= blockIdx }
        if (p < 0) p = speakableBlocks.size - 1
        return serverOffsetsMs.getOrElse(p.coerceAtLeast(0)) { 0 }
    }

    /** Resume playback of the current paragraph in whichever mode is active. */
    private fun playFromCurrent() {
        if (serverMode) startServerStream(msForBlock(currentIndex)) else speakCurrent()
    }

    /** ms already played on the current AudioTrack, from its playback head. */
    private fun trackPositionMs(): Int {
        val t = audioTrack ?: return trackStartMs
        val frames = runCatching { t.playbackHeadPosition.toLong() and 0xFFFFFFFFL }.getOrDefault(0L)
        return trackStartMs + (frames * 1000L / trackSampleRate).toInt()
    }

    private fun releasePlayer() {
        playThreadGen++            // signal any streaming thread to stop
        val t = audioTrack
        audioTrack = null
        playThread = null
        preparedIdx = -1
        runCatching { t?.pause() }
        runCatching { t?.flush() }
        runCatching { t?.release() }
    }

    /** Release the player and forget the paused position (position changed). */
    private fun discardPlayer() {
        releasePlayer()
        resumePositionMs = 0
        playToken++
        cancelAudioWatchdog()
    }

    /** Full reset: new article or stop. */
    private fun clearSynthCache() {
        discardPlayer()
        readyFiles.clear()
        synthesizing.clear()
        awaitingIdx = -1
        usingSpeakFallback = false
        fallbackToasted = false
        serverMode = false
        cacheDir.listFiles()?.filter { it.name.startsWith("tts-") }?.forEach { it.delete() }
    }

    private val utteranceListener = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) {
            if (utteranceId?.startsWith("spk-") == true) mainHandler.post {
                audioStarted = true
                cancelAudioWatchdog()
                logDbg("speaking (fallback) idx=$currentIndex")
                updateNotification()
            }
        }

        override fun onDone(utteranceId: String?) {
            val id = utteranceId ?: return
            mainHandler.post {
                when {
                    id.startsWith("synth-") -> {
                        val idx = id.removePrefix("synth-").toIntOrNull() ?: return@post
                        synthesizing.remove(idx)
                        val f = synthFile(idx)
                        if (f.exists() && f.length() > 128) {
                            readyFiles.add(idx)
                            logDbg("synth done idx=$idx (${f.length()} bytes)")
                            if (idx == awaitingIdx && isPlaying) { awaitingIdx = -1; startFilePlayback(idx, awaitingFromMs) }
                        } else {
                            logDbg("synth EMPTY idx=$idx")
                            if (idx == awaitingIdx && isPlaying) { awaitingIdx = -1; beginSpeakFallback("empty synth file") }
                        }
                    }
                    id.startsWith("spk-") -> {
                        val idx = id.removePrefix("spk-").toIntOrNull() ?: return@post
                        if (usingSpeakFallback && isPlaying && idx == currentIndex) {
                            logDbg("done (fallback) idx=$idx")
                            advanceAndSpeak()
                        }
                    }
                }
            }
        }

        private fun failed(utteranceId: String?) {
            val id = utteranceId ?: return
            mainHandler.post {
                if (id.startsWith("synth-")) {
                    val idx = id.removePrefix("synth-").toIntOrNull() ?: return@post
                    synthesizing.remove(idx)
                    logDbg("synth ERROR idx=$idx")
                    if (idx == awaitingIdx && isPlaying) { awaitingIdx = -1; beginSpeakFallback("synth error") }
                } else if (id.startsWith("spk-") && isPlaying) {
                    logDbg("fallback speak ERROR")
                    failEngineAndRetry("The voice engine reported an error")
                }
            }
        }

        override fun onError(utteranceId: String?, errorCode: Int) = failed(utteranceId)

        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) = failed(utteranceId)
    }

    private fun advanceAndSpeak() {
        val next = nextSpeakable(currentIndex + 1)
        if (next == null) {
            // Genuinely finished the article. Reset the listening position so a
            // replay starts from the top rather than the last paragraph.
            logDbg("article complete at idx=$currentIndex / ${blocks.size} blocks")
            currentIndex = 0
            handleStop()
        } else {
            currentIndex = next
            articleId?.let { app.repository.saveTtsPositionLocal(it, next) }
            // Neural voice: insert a short beat before the next paragraph so it's
            // easier to follow. Skipped for the system voice (which already
            // pauses at paragraph breaks). Cancelled if the user pauses/seeks.
            if (initializedEngine == sherpaEngine) {
                val token = playToken
                mainHandler.postDelayed({
                    if (isPlaying && playToken == token && currentIndex == next) speakCurrent()
                }, KALDI_PARAGRAPH_GAP_MS)
            } else {
                speakCurrent()
            }
        }
    }

    /** Start the current paragraph from the beginning. */
    private fun speakCurrent() {
        val idx = nextSpeakable(currentIndex) ?: run { handleStop(); return }
        currentIndex = idx
        resumePositionMs = 0
        playParagraph(idx, 0)
    }

    /** Resume: continue the current paragraph from where we paused (we release
     *  the AudioTrack on pause, so we re-stream from the saved byte offset). */
    private fun resumeSpeaking() {
        if (serverMode) { startServerStream(resumePositionMs); return }
        val idx = nextSpeakable(currentIndex) ?: run { handleStop(); return }
        currentIndex = idx
        playParagraph(idx, if (usingSpeakFallback) 0 else resumePositionMs)
    }

    private fun playParagraph(idx: Int, fromMs: Int) {
        if (tts == null || !ttsReady) { initTts(); return } // onInit → resumeSpeaking
        audioStarted = false
        playToken++
        if (usingSpeakFallback) { speakFallback(idx); return }
        if (readyFiles.contains(idx) && synthFile(idx).exists()) {
            startFilePlayback(idx, fromMs)
        } else {
            awaitingIdx = idx
            awaitingFromMs = fromMs
            releasePlayer()
            synthesize(idx)
            armAudioWatchdog(playToken)
            publishState(); updatePlaybackState(); updateNotification()
        }
    }

    /** Queue synthesis of the next few paragraphs so short ones don't outrun
     *  the engine (the cause of gaps between short paragraphs). synthesize() is
     *  idempotent, so re-requesting already-ready/in-flight ones is free. */
    private fun prefetchAhead(fromIdx: Int) {
        var p = fromIdx
        var queued = 0
        while (queued < PREFETCH_AHEAD) {
            val n = nextSpeakable(p + 1) ?: break
            synthesize(n)
            p = n
            queued++
        }
    }

    private fun synthesize(idx: Int) {
        if (idx < 0 || synthesizing.contains(idx) || readyFiles.contains(idx)) return
        val engine = tts ?: return
        val text = speakableText(blocks.getOrNull(idx) ?: return) ?: return
        synthesizing.add(idx)
        engine.setSpeechRate(app.settings.ttsSpeechRate)
        logDbg("synth queue idx=$idx (${text.length} chars) engine=${initializedEngine ?: "system"}")
        val res = engine.synthesizeToFile(text, android.os.Bundle(), synthFile(idx), "synth-$idx")
        if (res != TextToSpeech.SUCCESS) {
            synthesizing.remove(idx)
            logDbg("synth REJECTED idx=$idx code=$res")
            if (idx == awaitingIdx) beginSpeakFallback("synth rejected")
        }
    }

    /** Parsed PCM WAV layout. */
    private data class WavInfo(val sampleRate: Int, val channels: Int, val bits: Int, val dataOffset: Long, val dataLen: Long)

    private fun parseWav(file: java.io.File): WavInfo? = try {
        java.io.RandomAccessFile(file, "r").use { raf ->
            val riff = ByteArray(12); raf.readFully(riff)
            fun tag(b: ByteArray, o: Int) = String(b, o, 4, Charsets.US_ASCII)
            if (tag(riff, 0) != "RIFF" || tag(riff, 8) != "WAVE") return null
            var sampleRate = 0; var channels = 0; var bits = 0
            var dataOffset = -1L; var dataLen = 0L
            val hdr = ByteArray(8)
            while (raf.filePointer + 8 <= raf.length()) {
                raf.readFully(hdr)
                val id = tag(hdr, 0)
                // little-endian chunk size
                val size = ((hdr[4].toLong() and 0xFF)) or ((hdr[5].toLong() and 0xFF) shl 8) or
                    ((hdr[6].toLong() and 0xFF) shl 16) or ((hdr[7].toLong() and 0xFF) shl 24)
                if (id == "fmt ") {
                    val fmt = ByteArray(size.toInt().coerceAtLeast(16)); raf.readFully(fmt, 0, minOf(fmt.size, size.toInt()))
                    channels = (fmt[2].toInt() and 0xFF) or ((fmt[3].toInt() and 0xFF) shl 8)
                    sampleRate = (fmt[4].toInt() and 0xFF) or ((fmt[5].toInt() and 0xFF) shl 8) or
                        ((fmt[6].toInt() and 0xFF) shl 16) or ((fmt[7].toInt() and 0xFF) shl 24)
                    bits = (fmt[14].toInt() and 0xFF) or ((fmt[15].toInt() and 0xFF) shl 8)
                    if (size.toInt() > fmt.size) raf.seek(raf.filePointer + (size - fmt.size))
                } else if (id == "data") {
                    dataOffset = raf.filePointer
                    dataLen = minOf(size, raf.length() - dataOffset)
                    break
                } else {
                    raf.seek(raf.filePointer + size + (size and 1)) // chunks are word-aligned
                }
            }
            if (sampleRate <= 0 || bits != 16 || channels <= 0 || dataOffset < 0) null
            else WavInfo(sampleRate, channels, bits, dataOffset, dataLen)
        }
    } catch (e: Exception) { logDbg("WAV parse err: ${e.message}"); null }

    private fun startFilePlayback(idx: Int, fromMs: Int) {
        releasePlayer()
        val file = synthFile(idx)
        val wav = parseWav(file) ?: run { logDbg("bad WAV idx=$idx"); beginSpeakFallback("unparseable wav"); return }
        try {
            val channelMask = if (wav.channels >= 2) android.media.AudioFormat.CHANNEL_OUT_STEREO
                else android.media.AudioFormat.CHANNEL_OUT_MONO
            val minBuf = android.media.AudioTrack.getMinBufferSize(
                wav.sampleRate, channelMask, android.media.AudioFormat.ENCODING_PCM_16BIT
            ).coerceAtLeast(64 * 1024)
            val track = android.media.AudioTrack.Builder()
                .setAudioAttributes(playbackAudioAttributes)
                .setAudioFormat(
                    android.media.AudioFormat.Builder()
                        .setSampleRate(wav.sampleRate)
                        .setChannelMask(channelMask)
                        .setEncoding(android.media.AudioFormat.ENCODING_PCM_16BIT)
                        .build()
                )
                .setBufferSizeInBytes(minBuf)
                .setTransferMode(android.media.AudioTrack.MODE_STREAM)
                .build()
            audioTrack = track
            trackSampleRate = wav.sampleRate
            trackChannels = wav.channels
            trackStartMs = fromMs
            preparedIdx = idx
            audioStarted = true
            cancelAudioWatchdog()
            track.play()
            logDbg("playing (AudioTrack) idx=$idx sr=${wav.sampleRate} ch=${wav.channels} from=${fromMs}ms")
            prefetchAhead(idx) // keep synthesis ahead of playback (short paragraphs)
            publishState(); updatePlaybackState(); updateNotification()

            val frameBytes = wav.channels * 2
            val startByte = wav.dataOffset + (fromMs.toLong() * wav.sampleRate / 1000 * frameBytes)
                .coerceIn(0L, wav.dataLen)
            val myGen = ++playThreadGen
            playThread = Thread {
                try {
                    var bytesWritten = 0L
                    java.io.RandomAccessFile(file, "r").use { raf ->
                        raf.seek(startByte)
                        val buf = ByteArray(16 * 1024)
                        var remaining = wav.dataOffset + wav.dataLen - startByte
                        while (myGen == playThreadGen && remaining > 0) {
                            val toRead = minOf(buf.size.toLong(), remaining).toInt()
                            val n = raf.read(buf, 0, toRead)
                            if (n <= 0) break
                            var off = 0
                            while (off < n && myGen == playThreadGen) {
                                val w = track.write(buf, off, n - off)
                                if (w <= 0) { off = -1; break } // error / track stopped
                                off += w
                                bytesWritten += w
                            }
                            if (off < 0) break
                            remaining -= n
                        }
                    }
                    // Drain against the frames we ACTUALLY wrote (the header's
                    // declared length could exceed the real PCM), with a hard
                    // deadline so a stalled playback head can never hang the
                    // article on a paragraph — that was cutting articles short.
                    val framesToDrain = bytesWritten / frameBytes
                    val deadline = System.currentTimeMillis() +
                        (framesToDrain * 1000L / trackSampleRate) + 2000
                    while (myGen == playThreadGen &&
                        (track.playbackHeadPosition.toLong() and 0xFFFFFFFFL) < framesToDrain &&
                        System.currentTimeMillis() < deadline
                    ) Thread.sleep(40)
                    if (myGen == playThreadGen) mainHandler.post {
                        if (myGen == playThreadGen && isPlaying && preparedIdx == idx) {
                            logDbg("completed idx=$idx (${bytesWritten}B)")
                            synthFile(idx).delete(); readyFiles.remove(idx)
                            preparedIdx = -1; resumePositionMs = 0
                            advanceAndSpeak()
                        }
                    }
                } catch (e: Exception) {
                    mainHandler.post {
                        if (myGen == playThreadGen) {
                            logDbg("AudioTrack ERROR idx=$idx: ${e.message}")
                            if (isPlaying) beginSpeakFallback("audiotrack error")
                        }
                    }
                }
            }.also { it.isDaemon = true; it.start() }
        } catch (e: Exception) {
            logDbg("AudioTrack INIT ERROR idx=$idx: ${e.message}")
            beginSpeakFallback("audiotrack init")
        }
    }

    /**
     * Try to play server-synthesized (Kokoro) audio. Returns true if it started.
     * When the audio isn't cached yet it asks the server to generate it (so it's
     * ready next time) and returns false so the caller uses the device voice now.
     */
    private suspend fun tryStartServerVoice(id: String): Boolean {
        val meta = app.apiClient.audioMeta(id) ?: return false
        if (!meta.enabled) return false
        if (!meta.ready) {
            app.apiClient.requestAudioGeneration(id) // generate for next time
            logDbg("server audio not cached — requested generation; using device voice now")
            return false
        }
        val file = serverWavFile(id)
        if (file.length() < 44) {
            logDbg("downloading server audio for $id")
            if (!app.apiClient.downloadAudio(id, file)) { logDbg("server audio download failed"); return false }
        }
        if (id != articleId || !isPlaying) return false // superseded while downloading
        serverOffsetsMs = meta.offsetsMs
        serverMode = true
        logDbg("server voice: ${serverOffsetsMs.size} paragraphs, ${file.length()} bytes")
        startServerStream(msForBlock(currentIndex))
        return true
    }

    /** Stream the whole-article server WAV via AudioTrack from [fromMs], updating
     *  the current paragraph from playback time as it goes. */
    private fun startServerStream(fromMs: Int) {
        releasePlayer()
        val file = serverWavFile(articleId ?: return)
        val wav = parseWav(file) ?: run {
            logDbg("server WAV parse failed — device voice")
            serverMode = false; speakCurrent(); return
        }
        try {
            val channelMask = if (wav.channels >= 2) android.media.AudioFormat.CHANNEL_OUT_STEREO
                else android.media.AudioFormat.CHANNEL_OUT_MONO
            val minBuf = android.media.AudioTrack.getMinBufferSize(
                wav.sampleRate, channelMask, android.media.AudioFormat.ENCODING_PCM_16BIT
            ).coerceAtLeast(64 * 1024)
            val track = android.media.AudioTrack.Builder()
                .setAudioAttributes(playbackAudioAttributes)
                .setAudioFormat(
                    android.media.AudioFormat.Builder()
                        .setSampleRate(wav.sampleRate)
                        .setChannelMask(channelMask)
                        .setEncoding(android.media.AudioFormat.ENCODING_PCM_16BIT)
                        .build()
                )
                .setBufferSizeInBytes(minBuf)
                .setTransferMode(android.media.AudioTrack.MODE_STREAM)
                .build()
            audioTrack = track
            trackSampleRate = wav.sampleRate
            trackChannels = wav.channels
            trackStartMs = fromMs
            audioStarted = true
            cancelAudioWatchdog()
            track.play()
            logDbg("playing (server) from=${fromMs}ms")
            publishState(); updatePlaybackState(); updateNotification()

            val frameBytes = wav.channels * 2
            val startByte = wav.dataOffset + (fromMs.toLong() * wav.sampleRate / 1000 * frameBytes)
                .coerceIn(0L, wav.dataLen)
            val myGen = ++playThreadGen
            playThread = Thread {
                try {
                    var bytesWritten = 0L
                    var lastBlock = -1
                    java.io.RandomAccessFile(file, "r").use { raf ->
                        raf.seek(startByte)
                        val buf = ByteArray(16 * 1024)
                        var remaining = wav.dataOffset + wav.dataLen - startByte
                        while (myGen == playThreadGen && remaining > 0) {
                            val toRead = minOf(buf.size.toLong(), remaining).toInt()
                            val n = raf.read(buf, 0, toRead)
                            if (n <= 0) break
                            var off = 0
                            while (off < n && myGen == playThreadGen) {
                                val w = track.write(buf, off, n - off)
                                if (w <= 0) { off = -1; break }
                                off += w
                                bytesWritten += w
                            }
                            if (off < 0) break
                            remaining -= n
                            // advance the highlighted paragraph as playback moves
                            val blk = blockForMs(trackPositionMs())
                            if (blk != lastBlock) {
                                lastBlock = blk
                                mainHandler.post {
                                    if (myGen == playThreadGen && isPlaying && serverMode) {
                                        currentIndex = blk
                                        articleId?.let { app.repository.saveTtsPositionLocal(it, blk) }
                                        publishState(); updateNotification()
                                    }
                                }
                            }
                        }
                    }
                    val framesToDrain = bytesWritten / frameBytes
                    val deadline = System.currentTimeMillis() +
                        (framesToDrain * 1000L / trackSampleRate) + 2000
                    while (myGen == playThreadGen &&
                        (track.playbackHeadPosition.toLong() and 0xFFFFFFFFL) < framesToDrain &&
                        System.currentTimeMillis() < deadline
                    ) Thread.sleep(40)
                    if (myGen == playThreadGen) mainHandler.post {
                        if (myGen == playThreadGen && isPlaying && serverMode) {
                            logDbg("server complete (${bytesWritten}B)")
                            currentIndex = 0
                            handleStop()
                        }
                    }
                } catch (e: Exception) {
                    mainHandler.post {
                        if (myGen == playThreadGen) { logDbg("server stream ERROR: ${e.message}"); if (isPlaying) handleStop() }
                    }
                }
            }.also { it.isDaemon = true; it.start() }
        } catch (e: Exception) {
            logDbg("server AudioTrack INIT ERROR: ${e.message}")
            serverMode = false; speakCurrent()
        }
    }

    // Fallback: engine can't produce a playable file → use speak(). Audio still
    // works; headset buttons may not route (the engine owns the audio then).
    private fun beginSpeakFallback(why: String) {
        logDbg("SPEAK FALLBACK ($why) — headset buttons may not route now")
        usingSpeakFallback = true
        releasePlayer()
        if (!fallbackToasted) {
            fallbackToasted = true
            Toast.makeText(this, "This voice streams through the system; headset controls may be limited", Toast.LENGTH_LONG).show()
        }
        speakFallback(currentIndex)
    }

    private fun speakFallback(idx: Int) {
        val engine = tts ?: return
        val text = speakableText(blocks.getOrNull(idx) ?: return) ?: run { advanceAndSpeak(); return }
        currentIndex = idx
        audioStarted = false
        playToken++
        engine.setSpeechRate(app.settings.ttsSpeechRate)
        logDbg("speak (fallback) idx=$idx")
        val res = engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, "spk-$idx")
        if (res != TextToSpeech.SUCCESS) {
            logDbg("fallback speak REJECTED code=$res")
            failEngineAndRetry("The voice engine rejected the request")
            return
        }
        armAudioWatchdog(playToken)
        publishState(); updatePlaybackState(); updateNotification()
    }

    // If no audio starts, fall back / skip instead of sitting silent.
    private var audioWatchdogGen = 0
    private fun cancelAudioWatchdog() { audioWatchdogGen++ }
    private fun armAudioWatchdog(token: Int) {
        val w = ++audioWatchdogGen
        mainHandler.postDelayed({
            if (w == audioWatchdogGen && isPlaying && token == playToken && !audioStarted) {
                logDbg("WATCHDOG: no audio (token=$token)")
                if (!usingSpeakFallback) beginSpeakFallback("watchdog: no audio")
                else failEngineAndRetry("The selected voice isn't responding")
            }
        }, 12_000)
    }

    private fun failEngineAndRetry(reason: String) {
        logDbg("engine fallback: $reason (was ${initializedEngine ?: "system default"})")
        cancelAudioWatchdog()
        if (initializedEngine == null) {
            Toast.makeText(this, "$reason — skipping paragraph", Toast.LENGTH_LONG).show()
            advanceAndSpeak()
            return
        }
        Toast.makeText(this, "$reason — using the system voice", Toast.LENGTH_LONG).show()
        engineBlockedThisSession = initializedEngine
        tts?.stop(); tts?.shutdown(); tts = null; ttsReady = false
        // Give the fresh engine its own chance at file playback.
        usingSpeakFallback = false
        readyFiles.clear(); synthesizing.clear(); awaitingIdx = -1
        initTts() // re-inits with the system default, then resumeSpeaking
    }

    /** Engine that failed this session; skipped until the service restarts. */
    private var engineBlockedThisSession: String? = null

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
        val progressText = when {
            isPlaying && !audioStarted -> "Preparing voice…"
            blocks.isNotEmpty() -> "$pct% · ${articleSite.ifBlank { "Reading aloud" }}"
            else -> articleSite.ifBlank { "Reading aloud" }
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(articleTitle.ifBlank { "Earmark" })
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
                    // Show play/pause, next, and STOP in the collapsed view so
                    // the article can always be dismissed without expanding.
                    .setShowActionsInCompactView(1, 2, 3)
            )
            .build()
    }
}
