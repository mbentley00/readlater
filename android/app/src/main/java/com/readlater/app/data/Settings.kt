package com.readlater.app.data

import android.content.Context
import android.content.SharedPreferences

/**
 * Simple SharedPreferences wrapper for app configuration.
 */
class Settings(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("readlater_settings", Context.MODE_PRIVATE)

    /** Base URL of the companion server, stored without a trailing slash. */
    var serverUrl: String
        get() = prefs.getString(KEY_SERVER_URL, "").orEmpty()
        set(value) {
            prefs.edit().putString(KEY_SERVER_URL, value.trim().trimEnd('/')).apply()
        }

    /** Bearer token sent with every API request. */
    var token: String
        get() = prefs.getString(KEY_TOKEN, "").orEmpty()
        set(value) {
            prefs.edit().putString(KEY_TOKEN, value.trim()).apply()
        }

    /** Device (on-device engine) speech rate (0.5x .. 2.0x). */
    var ttsSpeechRate: Float
        get() = prefs.getFloat(KEY_TTS_RATE, 1.0f)
        set(value) {
            prefs.edit().putFloat(KEY_TTS_RATE, value.coerceIn(0.5f, 2.0f)).apply()
        }

    /** Server (Kokoro) voice speech rate, tracked separately from the device
     *  voice since the two engines sound best at different speeds. */
    var serverSpeechRate: Float
        get() = prefs.getFloat(KEY_SERVER_RATE, 1.0f)
        set(value) {
            prefs.edit().putFloat(KEY_SERVER_RATE, value.coerceIn(0.5f, 2.0f)).apply()
        }

    /** Playback speed for episodes shared into the app and played as audio.
     *  Separate from the voices: a recorded speaker is already at a natural
     *  pace, so this defaults to 2x. */
    var podcastSpeed: Float
        get() = prefs.getFloat(KEY_PODCAST_SPEED, 2.0f)
        set(value) {
            prefs.edit().putFloat(KEY_PODCAST_SPEED, value.coerceIn(0.5f, 3.0f)).apply()
        }

    /** Jump over the ad breaks the server marked in an episode's transcript,
     *  and leave them out when a voice reads the transcript instead. */
    var skipPodcastAds: Boolean
        get() = prefs.getBoolean(KEY_SKIP_PODCAST_ADS, true)
        set(value) {
            prefs.edit().putBoolean(KEY_SKIP_PODCAST_ADS, value).apply()
        }

    /** List podcast episodes under their own Podcasts tab instead of in the
     *  Inbox. Archive, search and saved views still show everything. */
    var podcastsTab: Boolean
        get() = prefs.getBoolean(KEY_PODCASTS_TAB, true)
        set(value) {
            prefs.edit().putBoolean(KEY_PODCASTS_TAB, value).apply()
        }

    /** Article list sort order (name of a SortMode enum value). */
    var listSort: String
        get() = prefs.getString(KEY_LIST_SORT, "NEWEST").orEmpty()
        set(value) {
            prefs.edit().putString(KEY_LIST_SORT, value).apply()
        }

    /** TTS engine package; "" = auto (prefer the sherpa neural engine when installed). */
    var ttsEngine: String
        get() = prefs.getString(KEY_TTS_ENGINE, "").orEmpty()
        set(value) {
            prefs.edit().putString(KEY_TTS_ENGINE, value).apply()
        }

    /** Use server-synthesized (Kokoro) audio when available, instead of the
     *  on-device engine. Falls back to on-device when audio isn't ready. */
    var useServerVoice: Boolean
        get() = prefs.getBoolean(KEY_SERVER_VOICE, false)
        set(value) {
            prefs.edit().putBoolean(KEY_SERVER_VOICE, value).apply()
        }

    /** When server voice is on but audio isn't ready, wait for the server to
     *  finish generating instead of falling back to the device voice. */
    var waitForServerVoice: Boolean
        get() = prefs.getBoolean(KEY_WAIT_SERVER_VOICE, false)
        set(value) {
            prefs.edit().putBoolean(KEY_WAIT_SERVER_VOICE, value).apply()
        }

    /** TTS voice name within the engine; "" = auto (highest quality). */
    var ttsVoice: String
        get() = prefs.getString(KEY_TTS_VOICE, "").orEmpty()
        set(value) {
            prefs.edit().putString(KEY_TTS_VOICE, value).apply()
        }

    /** Cached saved-view definitions (JSON) so the chips render instantly on
     *  open while a fresh copy is fetched from the server in the background. */
    var cachedViewsJson: String
        get() = prefs.getString(KEY_CACHED_VIEWS, "").orEmpty()
        set(value) { prefs.edit().putString(KEY_CACHED_VIEWS, value).apply() }

    /** Last GET /api/podcasts reply (JSON): the Podcasts tab's shows and
     *  waiting episodes, shown at once (and offline) while it refreshes. */
    var cachedPodcastsJson: String
        get() = prefs.getString(KEY_CACHED_PODCASTS, "").orEmpty()
        set(value) { prefs.edit().putString(KEY_CACHED_PODCASTS, value).apply() }

    /** updatedAt watermark of the last successful sync (for delta pulls). */
    var lastSyncAt: Long
        get() = prefs.getLong(KEY_LAST_SYNC, 0L)
        set(value) {
            prefs.edit().putLong(KEY_LAST_SYNC, value).apply()
        }

    /** Article open when the app was last killed; "" = none. Used to resume on cold start. */
    var lastArticleId: String
        get() = prefs.getString(KEY_LAST_ARTICLE, "").orEmpty()
        set(value) {
            prefs.edit().putString(KEY_LAST_ARTICLE, value).apply()
        }

    private companion object {
        const val KEY_SERVER_URL = "server_url"
        const val KEY_TOKEN = "token"
        const val KEY_TTS_RATE = "tts_speech_rate"
        const val KEY_SERVER_RATE = "server_speech_rate"
        const val KEY_PODCAST_SPEED = "podcast_speed"
        const val KEY_SKIP_PODCAST_ADS = "skip_podcast_ads"
        const val KEY_PODCASTS_TAB = "podcasts_tab"
        const val KEY_CACHED_VIEWS = "cached_views_json"
        const val KEY_CACHED_PODCASTS = "cached_podcasts_json"
        const val KEY_LIST_SORT = "list_sort"
        const val KEY_LAST_ARTICLE = "last_article_id"
        const val KEY_TTS_ENGINE = "tts_engine"
        const val KEY_TTS_VOICE = "tts_voice"
        const val KEY_SERVER_VOICE = "server_voice"
        const val KEY_WAIT_SERVER_VOICE = "wait_server_voice"
        const val KEY_LAST_SYNC = "last_sync_at"
    }
}
