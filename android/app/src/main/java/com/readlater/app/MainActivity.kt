package com.readlater.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
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

        setContent {
            ReadLaterTheme {
                val navController = rememberNavController()
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
                        ReaderScreen(
                            articleId = articleId,
                            onBack = { navController.popBackStack() }
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
}
