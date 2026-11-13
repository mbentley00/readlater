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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import com.readlater.app.ReadLaterApp
import com.readlater.app.data.ApiClient
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

/** Where sleep mode picks from (Settings.sleepSource holds the key). */
enum class SleepSource(val key: String, val label: String) {
    MIX("mix", "Mix"),
    ARCHIVE("archive", "Archive"),
    INBOX("inbox", "Inbox"),
    HISTORYLINK("historylink", "HistoryLink"),
    CAMBRIDGE("cambridge", "Cambridge");

    companion object {
        fun of(key: String) = entries.firstOrNull { it.key == key } ?: MIX
    }
}

/** One article on offer: already in the library, or found on a site and not
 *  saved until it is played. */
sealed interface SleepPick {
    /** Id or url — what not to offer again. */
    val key: String
    val title: String
    val siteName: String?
    val url: String
    val wordCount: Int
    val from: SleepSource

    data class Local(val article: ArticleEntity, override val from: SleepSource) : SleepPick {
        override val key get() = article.id
        override val title get() = article.title
        override val siteName get() = article.siteName
        override val url get() = article.url
        override val wordCount get() = article.wordCount
    }

    data class Remote(val c: ApiClient.SleepCandidate, override val from: SleepSource) : SleepPick {
        override val key get() = c.url
        override val title get() = c.title
        override val siteName get() = c.siteName
        override val url get() = c.url
        override val wordCount get() = c.wordCount
    }
}

/** Rough listening time at sleep speed (~165 wpm at 1×). */
private fun sleepListenMinutes(words: Int): Int =
    if (words <= 0) 0 else maxOf(1, (words / (165f * SLEEP_SPEED)).toInt())

/**
 * A random long article from [source], skipping [exclude]. Mix rolls a source
 * each time and falls back to the archive when an outside site lets it down.
 */
suspend fun nextSleepPick(repo: Repository, source: SleepSource, exclude: Set<String>): Result<SleepPick> {
    suspend fun local(from: SleepSource): Result<SleepPick> =
        repo.randomSleepArticle(exclude, inbox = from == SleepSource.INBOX)
            ?.let { Result.success(SleepPick.Local(it, from)) }
            ?: Result.failure(IllegalStateException(
                if (from == SleepSource.INBOX) "No long articles in the inbox." else "No long articles in the archive."
            ))
    suspend fun remote(from: SleepSource): Result<SleepPick> =
        repo.sleepCandidate(from.key, exclude).map { SleepPick.Remote(it, from) }

    return when (source) {
        SleepSource.ARCHIVE, SleepSource.INBOX -> local(source)
        SleepSource.HISTORYLINK, SleepSource.CAMBRIDGE -> remote(source)
        SleepSource.MIX -> {
            val roll = listOf(SleepSource.ARCHIVE, SleepSource.INBOX, SleepSource.HISTORYLINK, SleepSource.CAMBRIDGE).random()
            val first = if (roll == SleepSource.ARCHIVE || roll == SleepSource.INBOX) local(roll) else remote(roll)
            if (first.isSuccess) first else local(SleepSource.ARCHIVE).let { if (it.isSuccess) it else local(SleepSource.INBOX) }
        }
    }
}

/**
 * Start reading [pick] at [SLEEP_SPEED] as a plain single-article listen —
 * nothing is archived when it ends. One from a site is saved (to the archive)
 * first. Picks up a part-listened article where it was left, but starts a
 * finished one over. [timerMinutes] sets the sleep timer (0 clears it); null
 * leaves whatever timer is running alone (switching articles).
 */
suspend fun playSleepPick(
    context: Context,
    repo: Repository,
    pick: SleepPick,
    timerMinutes: Int?
): Result<Unit> {
    val article = when (pick) {
        is SleepPick.Local -> repo.articleWithBody(pick.article.id)
        is SleepPick.Remote -> repo.saveSleepCandidate(pick.c.url)
    }
    return article.map { a ->
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
}

/**
 * Sleep mode: offers a random long article — from the archive, the inbox,
 * HistoryLink or Cambridge, or a mix — to shuffle until one appeals, then reads
 * it at 1.1× with a sleep timer, 30 minutes by default. While sleep mode is
 * playing, the same dialog swaps in a different article.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SleepModeDialog(repo: Repository, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val settings = (context.applicationContext as ReadLaterApp).settings
    val scope = rememberCoroutineScope()
    val ttsState by TtsService.stateFlow.collectAsState()
    val playing = ttsState.sleepMode && ttsState.articleId != null
    val playingArticle by remember(ttsState.articleId) {
        ttsState.articleId?.let { repo.article(it) } ?: flowOf(null)
    }.collectAsState(initial = null)

    var source by remember { mutableStateOf(SleepSource.of(settings.sleepSource)) }
    var candidate by remember { mutableStateOf<SleepPick?>(null) }
    var offered by remember { mutableStateOf(setOf<String>()) }
    var picking by remember { mutableStateOf(false) }
    var starting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var timer by remember { mutableStateOf(DEFAULT_SLEEP_MINUTES) }
    var pickToken by remember { mutableStateOf(0) }

    fun shuffle() {
        val token = ++pickToken // a source change mid-pick wins over the old pick
        picking = true
        error = null
        scope.launch {
            val r = nextSleepPick(repo, source, offered + listOfNotNull(ttsState.articleId))
            if (token != pickToken) return@launch
            r.onSuccess { candidate = it; offered = offered + it.key }
                .onFailure { candidate = null; error = it.message ?: "Couldn't find an article." }
            picking = false
        }
    }

    /** Switch sleep playback to another random article right away. */
    fun playDifferent() {
        starting = true
        error = null
        scope.launch {
            nextSleepPick(repo, source, offered + listOfNotNull(ttsState.articleId))
                .onSuccess { next ->
                    offered = offered + next.key
                    playSleepPick(context, repo, next, timerMinutes = null)
                        .onFailure { error = "Couldn't load “${next.title}”: ${it.message ?: "offline?"}" }
                }
                .onFailure { error = it.message ?: "Couldn't find an article." }
            starting = false
        }
    }

    // Already playing in sleep mode: no pick needed until asked.
    LaunchedEffect(Unit) { if (!playing) shuffle() }

    // Tick the timer countdown.
    var now by remember { mutableLongStateOf(android.os.SystemClock.elapsedRealtime()) }
    LaunchedEffect(playing) {
        while (playing) {
            now = android.os.SystemClock.elapsedRealtime()
            delay(15_000)
        }
    }

    @Composable
    fun SourceChips() {
        Text("From", style = MaterialTheme.typography.labelMedium)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            SleepSource.entries.forEach { s ->
                FilterChip(
                    selected = source == s,
                    onClick = {
                        if (source != s) {
                            source = s
                            settings.sleepSource = s.key
                            if (!playing) shuffle()
                        }
                    },
                    label = { Text(s.label) }
                )
            }
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Sleep mode") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                if (playing) {
                    Text(
                        if (ttsState.isPlaying) "Now playing at ${SLEEP_SPEED}×" else "Paused",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary
                    )
                    Spacer(Modifier.height(4.dp))
                    playingArticle?.let {
                        PickSummary(it.title, it.siteName, it.url, it.wordCount, null)
                    }
                    Spacer(Modifier.height(8.dp))
                    val left = ttsState.sleepTimerEndsAt - now
                    Text(
                        if (ttsState.sleepTimerEndsAt > 0 && left > 0)
                            "Sleep timer: ${(left + 59_999) / 60_000} min left"
                        else "No sleep timer",
                        style = MaterialTheme.typography.bodySmall
                    )
                    Spacer(Modifier.height(12.dp))
                    SourceChips()
                    Spacer(Modifier.height(8.dp))
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
                    SourceChips()
                    Spacer(Modifier.height(12.dp))
                    if (picking) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                            Spacer(Modifier.width(12.dp))
                            Text(
                                when (source) {
                                    SleepSource.HISTORYLINK, SleepSource.CAMBRIDGE -> "Looking on ${source.label}…"
                                    else -> "Picking something long…"
                                }
                            )
                        }
                    } else {
                        candidate?.let { PickSummary(it.title, it.siteName, it.url, it.wordCount, it.from) }
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
                            playSleepPick(context, repo, pick, timer)
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
private fun PickSummary(title: String, siteName: String?, url: String, wordCount: Int, from: SleepSource?) {
    Text(title, style = MaterialTheme.typography.titleMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
    val site = siteName?.takeIf { it.isNotBlank() }
        ?: runCatching { android.net.Uri.parse(url).host?.removePrefix("www.") }.getOrNull().orEmpty()
    val mins = sleepListenMinutes(wordCount)
    Text(
        listOfNotNull(
            site.takeIf { it.isNotBlank() },
            if (wordCount > 0) "%,d words".format(wordCount) else null,
            if (mins > 0) "~$mins min at ${SLEEP_SPEED}×" else null
        ).joinToString(" · "),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )
    when (from) {
        SleepSource.INBOX -> "From your inbox — it stays there when it ends"
        SleepSource.ARCHIVE -> "From your archive"
        SleepSource.HISTORYLINK, SleepSource.CAMBRIDGE -> "New from ${from.label} — saved to your archive when you start"
        else -> null
    }?.let {
        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
    }
}
