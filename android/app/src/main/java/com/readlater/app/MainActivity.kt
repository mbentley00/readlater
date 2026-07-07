package com.readlater.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.readlater.app.ui.ArticleListScreen
import com.readlater.app.ui.HighlightsScreen
import com.readlater.app.ui.ReadLaterTheme
import com.readlater.app.ui.ReaderScreen
import com.readlater.app.ui.SettingsScreen

class MainActivity : ComponentActivity() {

    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            // Result ignored: playback works either way, only the media
            // notification is affected when the permission is denied.
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        val app = application as ReadLaterApp

        // A share (link sent from another app) saves in the background and opens
        // to the inbox rather than resuming the last-read article.
        val startedFromShare = handleShareIntent(intent)

        setContent {
            ReadLaterTheme {
                val navController = rememberNavController()

                // Resume where the user was if the app was killed in the background.
                // rememberSaveable keeps this from re-firing on rotation or when the
                // navigation back stack was restored by the system.
                var resumeHandled by rememberSaveable { mutableStateOf(false) }
                LaunchedEffect(Unit) {
                    if (!resumeHandled) {
                        resumeHandled = true
                        if (!startedFromShare) {
                            val last = app.settings.lastArticleId
                            if (last.isNotBlank()) navController.navigate("reader/$last")
                        }
                    }
                }

                NavHost(navController = navController, startDestination = "list") {
                    composable("list") {
                        ArticleListScreen(
                            onOpenArticle = { id -> navController.navigate("reader/$id") },
                            onOpenHighlights = { navController.navigate("highlights") },
                            onOpenSettings = { navController.navigate("settings") }
                        )
                    }
                    composable("reader/{articleId}") { entry ->
                        val articleId = entry.arguments?.getString("articleId").orEmpty()
                        // Remember the open article so a cold start can resume it;
                        // an intentional Back clears it — unless we're still
                        // listening to it (then it stays the resume target).
                        LaunchedEffect(articleId) { app.settings.lastArticleId = articleId }
                        val ttsState by com.readlater.app.tts.TtsService.stateFlow.collectAsState()
                        ReaderScreen(
                            articleId = articleId,
                            onBack = {
                                if (ttsState.articleId != articleId) app.settings.lastArticleId = ""
                                navController.popBackStack()
                            },
                            // Archiving the playing article advances to the next
                            // one — replace this article in the back stack so Back
                            // still returns to the list.
                            onOpenArticle = { nextId ->
                                navController.navigate("reader/$nextId") {
                                    popUpTo("reader/$articleId") { inclusive = true }
                                }
                            }
                        )
                    }
                    composable("highlights") {
                        HighlightsScreen(
                            onBack = { navController.popBackStack() },
                            onOpenArticle = { id -> navController.navigate("reader/$id") }
                        )
                    }
                    composable("settings") {
                        SettingsScreen(onBack = { navController.popBackStack() })
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleShareIntent(intent)
    }

    /** Save a shared link via the server (which fetches + extracts the page).
     *  Returns true if the intent was a share we handled. */
    private fun handleShareIntent(intent: Intent?): Boolean {
        if (intent?.action != Intent.ACTION_SEND) return false
        val shared = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty()
        if (shared.isEmpty()) return false
        val app = application as ReadLaterApp
        if (app.settings.token.isBlank()) {
            Toast.makeText(this, "Sign in to Earmark in Settings first", Toast.LENGTH_LONG).show()
            return true
        }
        Toast.makeText(this, "Saving to Earmark…", Toast.LENGTH_SHORT).show()
        lifecycleScope.launch {
            try {
                val title = app.apiClient.saveUrl(shared)
                Toast.makeText(this@MainActivity, "Saved: $title", Toast.LENGTH_LONG).show()
                runCatching { app.repository.syncNow() } // pull it into the list
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, "Couldn't save: ${e.message ?: "error"}", Toast.LENGTH_LONG).show()
            }
        }
        return true
    }
}
