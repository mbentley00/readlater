package com.readlater.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
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
import kotlinx.coroutines.flow.MutableStateFlow

class MainActivity : ComponentActivity() {

    companion object {
        /** Article id to open, from a notification (ShareUploadService's "ready"). */
        const val EXTRA_OPEN_ARTICLE = "openArticle"
    }

    /** An article a notification asked to open, until the nav graph takes it. */
    private val openRequest = MutableStateFlow<String?>(null)

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
        if (savedInstanceState == null) takeOpenRequest(intent)

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
                        val last = app.settings.lastArticleId
                        if (last.isNotBlank() && openRequest.value == null) navController.navigate("reader/$last")
                    }
                }
                val requested by openRequest.collectAsState()
                LaunchedEffect(requested) {
                    val id = requested ?: return@LaunchedEffect
                    openRequest.value = null
                    navController.navigate("reader/$id") { popUpTo("list") }
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
        takeOpenRequest(intent)
    }

    private fun takeOpenRequest(intent: Intent?) {
        intent?.getStringExtra(EXTRA_OPEN_ARTICLE)?.takeIf { it.isNotBlank() }?.let { openRequest.value = it }
    }
}
