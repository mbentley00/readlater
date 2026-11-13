package com.readlater.app.ui

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.readlater.app.data.ArticleEntity
import com.readlater.app.data.Repository
import com.readlater.app.tts.TtsService
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch

/** Sleep mode always reads at this speed, whatever the voice settings say. */
const val SLEEP_SPEED = 1.1f
private const val DEFAULT_SLEEP_MINUTES = 30
private val SLEEP_TIMER_CHOICES = listOf(0, 15, 30, 45, 60, 90)

/** Rough listening time at sleep speed (~165 wpm at 1×). */
private fun sleepListenMinutes(words: Int): Int =
    if (words <= 0) 0 else maxOf(1, (words / (165f * SLEEP_SPEED)).toInt())

/**
 * Fetch [article]'s body if needed and start reading it at [SLEEP_SPEED] as a
 * plain single-article listen. Picks up a part-listened article where it was
 * left, but starts a finished one over. [timerMinutes] > 0 sets the sleep
 * timer; null leaves whatever timer is running alone (switching articles).
 */
suspend fun playSleepArticle(
    context: Context,
    repo: Repository,
    article: ArticleEntity,
    timerMinutes: Int?
): Result<Unit> = repo.articleWithBody(article.id).map { a ->
    val count = a.paragraphCount
    val done = count > 0 && maxOf(a.ttsParagraph, a.readParagraph) >= count * 0.9f
    val play = Intent(context, TtsService::class.java)
        .setAction(TtsService.ACTION_PLAY)
        .putExtra(TtsService.EXTRA_ARTICLE_ID, a.id)
        .putExtra(TtsService.EXTRA_START_PARAGRAPH, if (done) 0 else -1)
        .putExtra(TtsService.EXTRA_AUTO_ADVANCE, false)
        .putExtra(TtsService.EXTRA_SPEED, SLEEP_SPEED)
    ContextCompat.startForegroundService(context, play)
    if (timerMinutes != null) {
        // Queued behind the PLAY; 0 still clears a timer left from before.
        context.startService(
            Intent(context, TtsService::class.java)
                .setAction(TtsService.ACTION_SET_SLEEP_TIMER)
                .putExtra(TtsService.EXTRA_SLEEP_MINUTES, timerMinutes)
        )
    }
}

/**
 * Sleep mode: offers a random long article from the archive (shuffle until one
 * appeals), then reads it at 1.1× with a sleep timer, 30 minutes by default.
 * While sleep mode is playing, the same dialog swaps in a different article.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SleepModeDialog(repo: Repository, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val ttsState by TtsService.stateFlow.collectAsState()
    val playing = ttsState.sleepMode && ttsState.articleId != null
    val playingArticle by remember(ttsState.articleId) {
        ttsState.articleId?.let { repo.article(it) } ?: flowOf(null)
    }.collectAsState(initial = null)

    var candidate by remember { mutableStateOf<ArticleEntity?>(null) }
    var offered by remember { mutableStateOf(setOf<String>()) }
    var picking by remember { mutableStateOf(true) }
    var starting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var timer by remember { mutableStateOf(DEFAULT_SLEEP_MINUTES) }

    fun shuffle() {
        picking = true
        error = null
        scope.launch {
            val exclude = offered + listOfNotNull(ttsState.articleId)
            val next = repo.randomSleepArticle(exclude)
            candidate = next
            if (next != null) offered = offered + next.id
            else error = "No long articles in the archive yet."
            picking = false
        }
    }

    /** Switch sleep playback to another random article right away. */
    fun playDifferent() {
        starting = true
        error = null
        scope.launch {
            val next = repo.randomSleepArticle(offered + listOfNotNull(ttsState.articleId))
            if (next == null) {
                error = "No other long articles in the archive."
            } else {
                offered = offered + next.id
                playSleepArticle(context, repo, next, timerMinutes = null)
                    .onFailure { error = "Couldn't load “${next.title}”: ${it.message ?: "offline?"}" }
            }
            starting = false
        }
    }

    // Already playing in sleep mode: no pick needed until asked.
    LaunchedEffect(Unit) { if (playing) picking = false else shuffle() }

    // Tick the timer countdown.
    var now by remember { mutableLongStateOf(android.os.SystemClock.elapsedRealtime()) }
    LaunchedEffect(playing) {
        while (playing) {
            now = android.os.SystemClock.elapsedRealtime()
            delay(15_000)
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Sleep mode") },
        text = {
            Column {
                if (playing) {
                    Text(
                        if (ttsState.isPlaying) "Now playing at ${SLEEP_SPEED}×" else "Paused",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary
                    )
                    Spacer(Modifier.height(4.dp))
                    ArticleSummary(playingArticle)
                    Spacer(Modifier.height(8.dp))
                    val left = ttsState.sleepTimerEndsAt - now
                    Text(
                        if (ttsState.sleepTimerEndsAt > 0 && left > 0)
                            "Sleep timer: ${(left + 59_999) / 60_000} min left"
                        else "No sleep timer",
                        style = MaterialTheme.typography.bodySmall
                    )
                    Spacer(Modifier.height(12.dp))
                    OutlinedButton(
                        onClick = { playDifferent() },
                        enabled = !starting,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        if (starting) {
                            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        } else {
                            Icon(Icons.Filled.Shuffle, contentDescription = null, modifier = Modifier.size(18.dp))
                        }
                        Spacer(Modifier.width(8.dp))
                        Text("Different article")
                    }
                } else {
                    if (picking) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                            Spacer(Modifier.width(12.dp))
                            Text("Picking something long…")
                        }
                    } else {
                        candidate?.let { ArticleSummary(it) }
                    }
                    Spacer(Modifier.height(8.dp))
                    OutlinedButton(
                        onClick = { shuffle() },
                        enabled = !picking && !starting,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Icon(Icons.Filled.Shuffle, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Another article")
                    }
                    Spacer(Modifier.height(12.dp))
                    Text("Sleep timer", style = MaterialTheme.typography.labelMedium)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        SLEEP_TIMER_CHOICES.forEach { m ->
                            FilterChip(
                                selected = timer == m,
                                onClick = { timer = m },
                                label = { Text(if (m == 0) "Off" else "$m min") }
                            )
                        }
                    }
                }
                error?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = {
            if (playing) {
                TextButton(onClick = onDismiss) { Text("Done") }
            } else {
                val pick = candidate
                TextButton(
                    enabled = pick != null && !picking && !starting,
                    onClick = {
                        if (pick == null) return@TextButton
                        starting = true
                        error = null
                        scope.launch {
                            playSleepArticle(context, repo, pick, timer)
                                .onSuccess { onDismiss() }
                                .onFailure { error = "Couldn't load it: ${it.message ?: "offline?"}" }
                            starting = false
                        }
                    }
                ) { Text(if (starting) "Loading…" else "Start") }
            }
        },
        dismissButton = {
            if (playing) {
                TextButton(onClick = {
                    context.startService(Intent(context, TtsService::class.java).setAction(TtsService.ACTION_STOP))
                    onDismiss()
                }) { Text("Stop") }
            } else {
                TextButton(onClick = onDismiss) { Text("Cancel") }
            }
        }
    )
}

@Composable
private fun ArticleSummary(a: ArticleEntity?) {
    if (a == null) return
    Text(a.title, style = MaterialTheme.typography.titleMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
    val site = a.siteName?.takeIf { it.isNotBlank() }
        ?: runCatching { android.net.Uri.parse(a.url).host?.removePrefix("www.") }.getOrNull().orEmpty()
    val mins = sleepListenMinutes(a.wordCount)
    Text(
        listOfNotNull(
            site.takeIf { it.isNotBlank() },
            if (a.wordCount > 0) "%,d words".format(a.wordCount) else null,
            if (mins > 0) "~$mins min at ${SLEEP_SPEED}×" else null
        ).joinToString(" · "),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )
}
