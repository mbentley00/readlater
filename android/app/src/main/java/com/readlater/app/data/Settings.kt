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

    /** Text-to-speech speech rate (0.5x .. 2.0x). */
    var ttsSpeechRate: Float
        get() = prefs.getFloat(KEY_TTS_RATE, 1.0f)
        set(value) {
            prefs.edit().putFloat(KEY_TTS_RATE, value.coerceIn(0.5f, 2.0f)).apply()
        }

    /** Article list sort order (name of a SortMode enum value). */
    var listSort: String
        get() = prefs.getString(KEY_LIST_SORT, "NEWEST").orEmpty()
        set(value) {
            prefs.edit().putString(KEY_LIST_SORT, value).apply()
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
        const val KEY_LIST_SORT = "list_sort"
        const val KEY_LAST_ARTICLE = "last_article_id"
    }
}
