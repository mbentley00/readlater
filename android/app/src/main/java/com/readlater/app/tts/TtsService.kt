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
        logDbg("PAUSE (idx=$currentIndex)")
        isPlaying = false
        clearSynthCache() // cancel the in-flight utterance
        tts?.stop()
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

    // Playback uses the engine's own speak() path. An earlier design
    // synthesized each paragraph to a file and played it via a MediaPlayer to
    // influence media-button routing, but that produced NO audio for some
    // engines/devices (sherpa and Google both) while speak() — the same path
    // the Settings preview uses — works reliably. Audio focus + an active
    // MediaSession give us the button routing instead.
    private var utteranceGen = 0    // increments per utterance; stale callbacks ignored
    private var audioStarted = false

    /** Invalidate any in-flight utterance so its callbacks are ignored. */
    private fun clearSynthCache() {
        utteranceGen++
        audioStarted = false
        cancelAudioWatchdog()
    }
    private fun discardPlayer() = clearSynthCache()

    // Each paragraph is spoken as a queue of sentences so pause/resume can
    // continue from the current sentence rather than restarting the paragraph.
    // utteranceId encodes "utt-<gen>-<sentenceIndex>".
    private var sentences: List<String> = emptyList()
    private var sentencesForIndex = -1
    private var sentenceIdx = 0

    private fun splitSentences(text: String): List<String> {
        val out = ArrayList<String>()
        val m = java.util.regex.Pattern
            .compile("[^.!?]*[.!?]+[\"')\\]]*\\s*|[^.!?]+$")
            .matcher(text)
        while (m.find()) m.group().trim().takeIf { it.isNotEmpty() }?.let { out.add(it) }
        return if (out.isEmpty()) listOf(text) else out
    }

    private fun parseUtt(id: String?): Pair<Int, Int>? {
        val parts = (id ?: return null).removePrefix("utt-").split("-")
        if (parts.size != 2) return null
        val g = parts[0].toIntOrNull() ?: return null
        val s = parts[1].toIntOrNull() ?: return null
        return g to s
    }

    private val utteranceListener = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) {
            val (gen, si) = parseUtt(utteranceId) ?: return
            mainHandler.post {
                if (gen == utteranceGen) {
                    audioStarted = true
                    sentenceIdx = si
                    cancelAudioWatchdog()
                    logDbg("speaking gen=$gen idx=$currentIndex s=$si/${sentences.size}")
                    updateNotification()
                }
            }
        }

        override fun onDone(utteranceId: String?) {
            val (gen, si) = parseUtt(utteranceId) ?: return
            mainHandler.post {
                if (gen == utteranceGen && isPlaying && si >= sentences.size - 1) {
                    // last sentence of the paragraph finished → next paragraph
                    logDbg("done gen=$gen idx=$currentIndex")
                    advanceAndSpeak()
                }
            }
        }

        private fun failed(utteranceId: String?) {
            val (gen, _) = parseUtt(utteranceId) ?: return
            mainHandler.post {
                if (gen == utteranceGen && isPlaying) {
                    logDbg("utterance ERROR gen=$gen")
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
            // Finished the article; handleStop pushes the final position.
            currentIndex = blocks.size - 1
            handleStop()
        } else {
            currentIndex = next
            articleId?.let { app.repository.saveTtsPositionLocal(it, next) }
            speakCurrent()
        }
    }

    /** Start the current paragraph from its first sentence. */
    private fun speakCurrent() {
        val idx = nextSpeakable(currentIndex) ?: run { handleStop(); return }
        currentIndex = idx
        sentences = speakableText(blocks[idx])?.let { splitSentences(it) } ?: run { handleStop(); return }
        sentencesForIndex = idx
        speakFromSentence(0)
    }

    /** Resume: continue the current paragraph from the sentence we paused on. */
    private fun resumeSpeaking() {
        if (sentencesForIndex == currentIndex && sentenceIdx in sentences.indices) {
            speakFromSentence(sentenceIdx)
        } else {
            speakCurrent()
        }
    }

    private fun speakFromSentence(startSentence: Int) {
        val engine = tts
        if (engine == null || !ttsReady) {
            initTts() // onInit → resumeSpeaking once ready
            return
        }
        audioStarted = false
        sentenceIdx = startSentence.coerceIn(0, (sentences.size - 1).coerceAtLeast(0))
        val gen = ++utteranceGen
        engine.setSpeechRate(app.settings.ttsSpeechRate)
        logDbg("speak gen=$gen idx=$currentIndex from s=$sentenceIdx/${sentences.size} engine=${initializedEngine ?: "system"}")
        var queued = false
        for (i in sentenceIdx until sentences.size) {
            val mode = if (!queued) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
            val res = engine.speak(sentences[i], mode, null, "utt-$gen-$i")
            if (res != TextToSpeech.SUCCESS) {
                logDbg("speak REJECTED idx=$currentIndex s=$i code=$res")
                failEngineAndRetry("The voice engine rejected the request")
                return
            }
            queued = true
        }
        if (!queued) { advanceAndSpeak(); return }
        armAudioWatchdog(gen)
        publishState()
        updatePlaybackState()
        updateNotification()
    }

    // If audio never starts (engine stuck loading a model, or silently
    // failing), fall back to the system voice instead of sitting silent.
    private var audioWatchdogGen = 0
    private fun cancelAudioWatchdog() { audioWatchdogGen++ }
    private fun armAudioWatchdog(utterGen: Int) {
        val w = ++audioWatchdogGen
        mainHandler.postDelayed({
            if (w == audioWatchdogGen && isPlaying && utterGen == utteranceGen && !audioStarted) {
                logDbg("WATCHDOG: no audio for gen=$utterGen")
                failEngineAndRetry("The selected voice isn't responding")
            }
        }, 12_000)
    }

    private fun failEngineAndRetry(reason: String) {
        logDbg("fallback: $reason (was ${initializedEngine ?: "system default"})")
        cancelAudioWatchdog()
        if (initializedEngine == null) {
            // already on the system default — skip this paragraph
            Toast.makeText(this, "$reason — skipping paragraph", Toast.LENGTH_LONG).show()
            advanceAndSpeak()
            return
        }
        Toast.makeText(this, "$reason — using the system voice", Toast.LENGTH_LONG).show()
        engineBlockedThisSession = initializedEngine
        tts?.stop()
        tts?.shutdown()
        tts = null
        ttsReady = false
        initTts() // re-inits with the system default, then speakCurrent
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
