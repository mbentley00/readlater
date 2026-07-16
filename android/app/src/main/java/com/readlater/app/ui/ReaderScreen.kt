package com.readlater.app.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.WebView
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.PlaylistPlay
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.Bedtime
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.MyLocation
import androidx.compose.material.icons.filled.OpenInBrowser
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material.icons.filled.Unarchive
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.BottomAppBar
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.readlater.app.ReadLaterApp
import com.readlater.app.data.Block
import com.readlater.app.data.HighlightEntity
import com.readlater.app.data.HtmlParser
import com.readlater.app.tts.TtsService
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import java.util.Locale
import kotlin.math.roundToInt

/**
 * The LazyColumn renders the article header as item 0, so paragraph N is list
 * item N + 1. Paragraph indices (readParagraph, ttsParagraph, highlight
 * anchors) live in *block* space; the list scrolls in *item* space. Always
 * convert — mixing the two is why "go to reading position" landed a paragraph
 * early, and why paragraph 0 scrolled to the header and pushed the paragraph
 * itself to the bottom of the screen.
 */
private const val HEADER_ITEMS = 1

private fun blockToItem(block: Int) = block + HEADER_ITEMS
private fun itemToBlock(item: Int) = (item - HEADER_ITEMS).coerceAtLeast(0)

private suspend fun LazyListState.scrollToBlock(block: Int) = scrollToItem(blockToItem(block))
private suspend fun LazyListState.animateScrollToBlock(block: Int) =
    animateScrollToItem(blockToItem(block))

/** What the reader's bottom sheet is currently showing. */
private sealed class SheetTarget {
    data class Create(val index: Int, val text: String) : SheetTarget()
    data class View(val index: Int) : SheetTarget()
}

/** A sub-paragraph highlight the user is building by press-hold-dragging across
 *  words. `start` until `end` are character offsets into block `block`'s text. */
private data class WordSelection(val block: Int, val start: Int, val end: Int, val text: String)

private fun sendTtsCommand(
    context: Context,
    action: String,
    articleId: String? = null,
    startParagraph: Int? = null
) {
    val intent = Intent(context, TtsService::class.java).setAction(action)
    if (action == TtsService.ACTION_PLAY || action == TtsService.ACTION_SET_POSITION) {
        intent.putExtra(TtsService.EXTRA_ARTICLE_ID, articleId)
        intent.putExtra(TtsService.EXTRA_START_PARAGRAPH, startParagraph ?: -1)
    }
    if (action == TtsService.ACTION_PLAY) {
        // PLAY must go through startForegroundService so the service may promote itself.
        ContextCompat.startForegroundService(context, intent)
    } else {
        context.startService(intent)
    }
}

@OptIn(ExperimentalMaterial3Api::class, FlowPreview::class)
@Composable
fun ReaderScreen(articleId: String, onBack: () -> Unit, onOpenArticle: (String) -> Unit = {}) {
    val context = LocalContext.current
    val app = context.applicationContext as ReadLaterApp
    val repo = app.repository
    val settings = app.settings
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }

    val article by repo.article(articleId).collectAsState(initial = null)
    val highlights by repo.highlightsFor(articleId).collectAsState(initial = emptyList())
    val blocks = remember(article?.html) {
        article?.html?.let { HtmlParser.parse(it) } ?: emptyList()
    }
    val currentBlocks by rememberUpdatedState(blocks)
    val highlightsByPara = remember(highlights) { highlights.groupBy { it.paragraphIndex } }

    val ttsState by TtsService.stateFlow.collectAsState()
    val isTtsThisArticle = ttsState.articleId == articleId

    val listState = rememberLazyListState()
    var didInitialScroll by remember { mutableStateOf(false) }

    // Bodies of archived articles aren't synced eagerly — fetch on open.
    LaunchedEffect(article?.id, article?.html == null) {
        val a = article
        if (a != null && a.html == null) {
            repo.fetchArticleBody(a.id)
        }
    }

    // If a headphone triple-tap archived THIS article and moved playback to the
    // next one while the app was away, follow it — otherwise you come back to
    // the stale, now-archived article with playback happening elsewhere.
    LaunchedEffect(article?.archived, ttsState.articleId, ttsState.isPlaying) {
        val a = article
        val playing = ttsState.articleId
        if (a != null && a.archived && ttsState.isPlaying && playing != null && playing != articleId) {
            onOpenArticle(playing)
        }
    }

    // Whether the view auto-follows the spoken paragraph. On by default;
    // switched off as soon as the user scrolls by hand, back on via the
    // follow button or by (re)starting playback.
    var followTts by remember { mutableStateOf(true) }
    LaunchedEffect(listState) {
        listState.interactionSource.interactions.collect { interaction ->
            if (interaction is DragInteraction.Start) followTts = false
        }
    }

    // Restore the saved position once the body is available. When the manual
    // scroll position and the listening (TTS) position have meaningfully
    // diverged, ask which one to resume instead of guessing.
    var resumeChoice by remember { mutableStateOf<Pair<Int, Int>?>(null) } // (read, tts)
    LaunchedEffect(blocks) {
        if (!didInitialScroll && blocks.isNotEmpty()) {
            val read = (article?.readParagraph ?: 0).coerceIn(0, blocks.size - 1)
            val tts = (article?.ttsParagraph ?: 0).coerceIn(0, blocks.size - 1)
            when {
                // Already listening to this article — never interrupt with the
                // chooser. This fires when you switch to another app mid-listen
                // (the Activity is torn down and recreated) and come back while
                // playback is still running; just land on the spoken paragraph
                // and follow along.
                isTtsThisArticle && ttsState.isPlaying -> {
                    listState.scrollToBlock(ttsState.paragraphIndex.coerceIn(0, blocks.size - 1))
                }
                read > 0 && tts > 0 && kotlin.math.abs(read - tts) > 2 -> {
                    listState.scrollToBlock(minOf(read, tts))
                    resumeChoice = read to tts
                }
                else -> listState.scrollToBlock(maxOf(read, tts))
            }
            didInitialScroll = true
        }
    }

    // Follow the paragraph currently being spoken (unless the user scrolled away).
    LaunchedEffect(ttsState.paragraphIndex, ttsState.isPlaying, isTtsThisArticle, followTts) {
        if (followTts && isTtsThisArticle && ttsState.isPlaying &&
            ttsState.paragraphIndex in blocks.indices
        ) {
            listState.animateScrollToBlock(ttsState.paragraphIndex)
        }
    }

    // Continuously persist the manual scroll position (debounced, local-only;
    // the dirty flag gets it pushed on the next sync). Survives the app being
    // killed mid-read. Suspended only while auto-follow is driving the scroll —
    // TTS keeps its own separate position.
    LaunchedEffect(didInitialScroll, isTtsThisArticle, ttsState.isPlaying, followTts) {
        if (!didInitialScroll || (isTtsThisArticle && ttsState.isPlaying && followTts)) return@LaunchedEffect
        snapshotFlow { itemToBlock(listState.firstVisibleItemIndex) }
            .distinctUntilChanged()
            .debounce(800)
            .collect { block ->
                if (currentBlocks.isNotEmpty()) {
                    repo.saveReadPositionLocal(articleId, block.coerceIn(0, currentBlocks.size - 1))
                }
            }
    }

    // Persist the reading position when leaving the screen (works without TTS too).
    DisposableEffect(articleId) {
        onDispose {
            if (didInitialScroll && currentBlocks.isNotEmpty()) {
                val block = itemToBlock(listState.firstVisibleItemIndex)
                    .coerceIn(0, currentBlocks.size - 1)
                repo.saveReadPosition(articleId, block)
            }
        }
    }

    // Device and server voices have independent speeds. The bottom-bar control
    // shows/adjusts whichever is currently in use (server when it's playing or
    // preferred, device otherwise).
    var deviceRate by remember { mutableStateOf(settings.ttsSpeechRate) }
    var serverRate by remember { mutableStateOf(settings.serverSpeechRate) }
    val serverActive = if (isTtsThisArticle) ttsState.serverVoice else settings.useServerVoice
    val speechRate = if (serverActive) serverRate else deviceRate
    var sheetTarget by remember { mutableStateOf<SheetTarget?>(null) }
    // In-progress word-level selection (double-tap a word to start, tap more to extend).
    var wordSel by remember { mutableStateOf<WordSelection?>(null) }
    var menuOpen by remember { mutableStateOf(false) }
    var sleepDialog by remember { mutableStateOf(false) }
    // "Report bad parse" chooser + in-flight flag, and the raw original to show
    // in a WebView (non-null = viewer open).
    var reparseDialog by remember { mutableStateOf(false) }
    var reparsing by remember { mutableStateOf(false) }
    var sourceView by remember { mutableStateOf<String?>(null) }

    // How far through the article the bottom of the viewport is (0..1).
    val readProgress by remember {
        derivedStateOf {
            val total = currentBlocks.size
            if (total == 0) 0f
            else {
                val lastItem = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
                ((itemToBlock(lastItem) + 1).toFloat() / total).coerceIn(0f, 1f)
            }
        }
    }

    fun setRate(rate: Float) {
        val newRate = rate.coerceIn(0.5f, 2.0f)
        if (newRate == speechRate) return
        if (serverActive) { serverRate = newRate; settings.serverSpeechRate = newRate }
        else { deviceRate = newRate; settings.ttsSpeechRate = newRate }
        // Restart the current paragraph so the new rate takes effect immediately.
        if (isTtsThisArticle && ttsState.isPlaying) {
            sendTtsCommand(context, TtsService.ACTION_PLAY, articleId, ttsState.paragraphIndex)
        }
    }

    // Find in article: match block indices, navigable with prev/next.
    var searchActive by remember { mutableStateOf(false) }
    var searchQuery by remember { mutableStateOf("") }
    val matchBlocks = remember(searchQuery, blocks) {
        val q = searchQuery.trim()
        if (q.length < 2) emptyList()
        else blocks.indices.filter { blockPlainText(blocks[it]).contains(q, ignoreCase = true) }
    }
    var currentMatch by remember { mutableStateOf(0) }
    LaunchedEffect(matchBlocks) {
        currentMatch = 0
        if (matchBlocks.isNotEmpty()) listState.scrollToBlock(matchBlocks[0])
    }
    fun goToMatch(delta: Int) {
        if (matchBlocks.isEmpty()) return
        currentMatch = ((currentMatch + delta) % matchBlocks.size + matchBlocks.size) % matchBlocks.size
        scope.launch { listState.scrollToBlock(matchBlocks[currentMatch]) }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            if (searchActive) {
                TopAppBar(
                    navigationIcon = {
                        IconButton(onClick = { searchActive = false; searchQuery = "" }) {
                            Icon(Icons.Filled.Close, contentDescription = "Close search")
                        }
                    },
                    title = {
                        TextField(
                            value = searchQuery,
                            onValueChange = { searchQuery = it },
                            placeholder = { Text("Find in article") },
                            singleLine = true,
                            colors = TextFieldDefaults.colors(
                                focusedContainerColor = Color.Transparent,
                                unfocusedContainerColor = Color.Transparent,
                                focusedIndicatorColor = Color.Transparent,
                                unfocusedIndicatorColor = Color.Transparent
                            ),
                            modifier = Modifier.fillMaxWidth()
                        )
                    },
                    actions = {
                        if (searchQuery.trim().length >= 2) {
                            Text(
                                text = if (matchBlocks.isEmpty()) "0" else "${currentMatch + 1}/${matchBlocks.size}",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            IconButton(onClick = { goToMatch(-1) }, enabled = matchBlocks.isNotEmpty()) {
                                Icon(Icons.Filled.KeyboardArrowUp, contentDescription = "Previous match")
                            }
                            IconButton(onClick = { goToMatch(1) }, enabled = matchBlocks.isNotEmpty()) {
                                Icon(Icons.Filled.KeyboardArrowDown, contentDescription = "Next match")
                            }
                        }
                    }
                )
                return@Scaffold
            }
            TopAppBar(
                expandedHeight = 84.dp,
                title = {
                    val a = article
                    Column {
                        Text(
                            text = a?.title.orEmpty(),
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.titleMedium,
                            lineHeight = MaterialTheme.typography.titleMedium.fontSize * 1.15f
                        )
                        if (a != null) {
                            val publisher = a.siteName?.takeIf { it.isNotBlank() }
                                ?: runCatching { Uri.parse(a.url).host?.removePrefix("www.") }.getOrNull().orEmpty()
                            val pct = (readProgress * 100).toInt()
                            val wordsLeft = (a.wordCount * (1 - readProgress)).toInt()
                            val minutesLeft = if (wordsLeft > 0)
                                kotlin.math.max(1, kotlin.math.round(wordsLeft / 225.0).toInt()) else 0
                            val prog = if (blocks.isNotEmpty())
                                (if (minutesLeft > 0 && pct < 100) "$pct% · $minutesLeft min left" else "$pct%") else ""
                            val sub = listOf(publisher, prog).filter { it.isNotBlank() }.joinToString(" · ")
                            if (sub.isNotBlank()) {
                                Text(
                                    text = sub,
                                    style = MaterialTheme.typography.labelMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )
                            }
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    val a = article
                    IconButton(onClick = { searchActive = true }) {
                        Icon(Icons.Filled.Search, contentDescription = "Find in article")
                    }
                    if (a != null) {
                        // Archive & play next: archive this one, open the next
                        // inbox article, and auto-start playing it.
                        if (!a.archived) {
                            IconButton(onClick = {
                                scope.launch {
                                    val next = repo.nextInboxArticle(a)
                                    repo.toggleArchive(a)
                                    if (next != null) {
                                        sendTtsCommand(context, TtsService.ACTION_PLAY, next.id, 0)
                                        onOpenArticle(next.id)
                                    } else {
                                        sendTtsCommand(context, TtsService.ACTION_STOP)
                                        onBack()
                                    }
                                }
                            }) {
                                Icon(
                                    Icons.AutoMirrored.Filled.PlaylistPlay,
                                    contentDescription = "Archive and play next"
                                )
                            }
                        }
                        // Plain archive: archive/unarchive and return to the list.
                        // If this article is the one playing, stop playback too.
                        IconButton(onClick = {
                            val wasArchived = a.archived
                            repo.toggleArchive(a)
                            if (!wasArchived) {
                                if (isTtsThisArticle) sendTtsCommand(context, TtsService.ACTION_STOP)
                                onBack()
                            }
                        }) {
                            Icon(
                                if (a.archived) Icons.Filled.Unarchive else Icons.Filled.Archive,
                                contentDescription = if (a.archived) "Unarchive" else "Archive"
                            )
                        }
                        Box {
                            IconButton(onClick = { menuOpen = true }) {
                                Icon(Icons.Filled.MoreVert, contentDescription = "More")
                            }
                            DropdownMenu(
                                expanded = menuOpen,
                                onDismissRequest = { menuOpen = false }
                            ) {
                                DropdownMenuItem(
                                    text = { Text("View original") },
                                    leadingIcon = {
                                        Icon(Icons.Filled.OpenInBrowser, contentDescription = null)
                                    },
                                    onClick = {
                                        menuOpen = false
                                        val url = a.url
                                        if (url.startsWith("http://") || url.startsWith("https://")) {
                                            // A real web page — open it in the browser.
                                            try {
                                                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                                            } catch (_: Exception) { /* no browser */ }
                                        } else {
                                            // Email/PDF import — show the captured source in a WebView.
                                            scope.launch {
                                                val src = runCatching { repo.articleSource(a.id) }.getOrNull()
                                                when {
                                                    src?.source != null -> sourceView = src.source
                                                    src != null && src.url.startsWith("http") ->
                                                        try { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(src.url))) } catch (_: Exception) {}
                                                    else -> snackbarHostState.showSnackbar("No original source is available for this article")
                                                }
                                            }
                                        }
                                    }
                                )
                                DropdownMenuItem(
                                    text = { Text("Report bad parse") },
                                    leadingIcon = {
                                        Icon(Icons.Filled.Build, contentDescription = null)
                                    },
                                    onClick = { menuOpen = false; reparseDialog = true }
                                )
                                DropdownMenuItem(
                                    text = {
                                        val ends = ttsState.sleepTimerEndsAt
                                        val mins = if (ends > 0)
                                            (((ends - android.os.SystemClock.elapsedRealtime()) / 60000L) + 1).toInt().coerceAtLeast(0) else 0
                                        Text(if (mins > 0) "Sleep timer · ${mins}m" else "Sleep timer")
                                    },
                                    leadingIcon = {
                                        Icon(Icons.Filled.Bedtime, contentDescription = null)
                                    },
                                    onClick = { menuOpen = false; sleepDialog = true }
                                )
                                DropdownMenuItem(
                                    text = { Text("Delete") },
                                    leadingIcon = {
                                        Icon(Icons.Filled.Delete, contentDescription = null)
                                    },
                                    onClick = {
                                        menuOpen = false
                                        repo.deleteArticle(a)
                                        onBack()
                                    }
                                )
                            }
                        }
                    }
                }
            )
        },
        bottomBar = {
            BottomAppBar {
                IconButton(onClick = { sendTtsCommand(context, TtsService.ACTION_PREV) }) {
                    Icon(Icons.Filled.SkipPrevious, contentDescription = "Previous paragraph")
                }
                IconButton(
                    enabled = article?.html != null,
                    onClick = {
                        when {
                            isTtsThisArticle && ttsState.isPlaying ->
                                sendTtsCommand(context, TtsService.ACTION_PAUSE)
                            isTtsThisArticle ->
                                sendTtsCommand(context, TtsService.ACTION_RESUME)
                            else -> {
                                // Start reading from where the view is, not the top.
                                followTts = true
                                sendTtsCommand(
                                    context,
                                    TtsService.ACTION_PLAY,
                                    articleId,
                                    itemToBlock(listState.firstVisibleItemIndex)
                                        .coerceIn(0, (blocks.size - 1).coerceAtLeast(0))
                                )
                            }
                        }
                    }
                ) {
                    if (isTtsThisArticle && ttsState.preparing) {
                        CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
                    } else {
                        Icon(
                            if (isTtsThisArticle && ttsState.isPlaying) Icons.Filled.Pause
                            else Icons.Filled.PlayArrow,
                            contentDescription = "Play or pause"
                        )
                    }
                }
                IconButton(onClick = { sendTtsCommand(context, TtsService.ACTION_NEXT) }) {
                    Icon(Icons.Filled.SkipNext, contentDescription = "Next paragraph")
                }
                // Stop playback entirely and dismiss the player (only while active).
                if (isTtsThisArticle) {
                    IconButton(onClick = { sendTtsCommand(context, TtsService.ACTION_STOP) }) {
                        Icon(Icons.Filled.Stop, contentDescription = "Stop")
                    }
                    // Auto-advance ("binge"): archive each article when it finishes
                    // and play the next, on down the inbox until you stop. Only
                    // shown once you're actually listening to this article.
                    IconButton(onClick = { sendTtsCommand(context, TtsService.ACTION_TOGGLE_AUTO_ADVANCE) }) {
                        Icon(
                            Icons.AutoMirrored.Filled.PlaylistPlay,
                            contentDescription = "Auto-advance: archive and play the next when this finishes",
                            tint = if (ttsState.autoAdvance) MaterialTheme.colorScheme.primary
                            else LocalContentColor.current
                        )
                    }
                }
                // Jump the view back to the reading position and resume following.
                IconButton(onClick = {
                    followTts = true
                    val target = if (isTtsThisArticle) ttsState.paragraphIndex
                    else article?.readParagraph ?: 0
                    scope.launch {
                        if (blocks.isNotEmpty()) {
                            listState.animateScrollToBlock(target.coerceIn(0, blocks.size - 1))
                        }
                    }
                }) {
                    Icon(
                        Icons.Filled.MyLocation,
                        contentDescription = "Go to reading position",
                        tint = if (followTts) MaterialTheme.colorScheme.primary
                        else LocalContentColor.current
                    )
                }
                // Make the current view the position — both the scroll position
                // and the listening position, whatever the playback state.
                IconButton(onClick = {
                    val idx = itemToBlock(listState.firstVisibleItemIndex)
                        .coerceIn(0, (blocks.size - 1).coerceAtLeast(0))
                    followTts = true
                    repo.saveReadPosition(articleId, idx)
                    if (isTtsThisArticle) {
                        // live service: move its in-memory position too
                        sendTtsCommand(context, TtsService.ACTION_SET_POSITION, articleId, idx)
                    } else {
                        repo.saveTtsPosition(articleId, idx)
                    }
                    scope.launch { snackbarHostState.showSnackbar("Reading position set to here") }
                }) {
                    Icon(Icons.Filled.PushPin, contentDescription = "Set reading position to here")
                }
                Spacer(modifier = Modifier.weight(1f))
                // Speed: a button showing the current rate opens a slider popup.
                var speedMenu by remember { mutableStateOf(false) }
                var pendingRate by remember { mutableStateOf(speechRate) }
                Box {
                    TextButton(onClick = { pendingRate = speechRate; speedMenu = true }) {
                        Icon(Icons.Filled.Speed, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(modifier = Modifier.width(4.dp))
                        Text(String.format(Locale.US, "%.2f×", speechRate), style = MaterialTheme.typography.labelLarge)
                    }
                    DropdownMenu(expanded = speedMenu, onDismissRequest = { speedMenu = false }) {
                        Column(modifier = Modifier.width(260.dp).padding(horizontal = 16.dp, vertical = 8.dp)) {
                            Text(
                                text = (if (serverActive) "Server voice" else "Device voice") +
                                    " · " + String.format(Locale.US, "%.2f×", pendingRate),
                                style = MaterialTheme.typography.labelLarge
                            )
                            Slider(
                                value = pendingRate,
                                onValueChange = { pendingRate = (it * 20f).roundToInt() / 20f },
                                onValueChangeFinished = { setRate(pendingRate) },
                                valueRange = 0.5f..2.0f,
                                steps = 29
                            )
                        }
                    }
                }
            }
        }
    ) { padding ->
        val a = article
        when {
            a == null -> {
                Box(
                    modifier = Modifier.fillMaxSize().padding(padding),
                    contentAlignment = Alignment.Center
                ) {
                    CircularProgressIndicator()
                }
            }

            a.html == null -> {
                Box(
                    modifier = Modifier.fillMaxSize().padding(padding),
                    contentAlignment = Alignment.Center
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            text = "Not downloaded yet — sync to fetch this article.",
                            style = MaterialTheme.typography.bodyLarge,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.padding(horizontal = 32.dp)
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        Button(onClick = {
                            scope.launch {
                                repo.fetchArticleBody(articleId).onFailure {
                                    snackbarHostState.showSnackbar(
                                        "Download failed: ${it.message ?: "unknown error"}"
                                    )
                                }
                            }
                        }) {
                            Text("Download now")
                        }
                    }
                }
            }

            else -> {
                Column(modifier = Modifier.fillMaxSize().padding(padding)) {
                LinearProgressIndicator(
                    progress = { readProgress },
                    modifier = Modifier.fillMaxWidth().height(3.dp)
                )
                LazyColumn(
                    state = listState,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp)
                ) {
                    item(key = "__header__") {
                        article?.let { ArticleHeader(it) }
                    }
                    itemsIndexed(blocks) { index, block ->
                        BlockItem(
                            block = block,
                            paraHighlights = highlightsByPara[index].orEmpty(),
                            searchQuery = if (searchActive) searchQuery.trim() else "",
                            isSpoken = isTtsThisArticle && ttsState.paragraphIndex == index,
                            selRange = wordSel?.takeIf { it.block == index }?.let { it.start until it.end },
                            // Double-tap highlights the whole paragraph.
                            onDoubleTap = { text ->
                                wordSel = null
                                repo.addHighlight(articleId, text, null, index)
                                scope.launch { snackbarHostState.showSnackbar("Highlighted") }
                            },
                            // Press-hold-drag builds a word-level selection.
                            onWordSelect = { s, e, sel -> wordSel = WordSelection(index, s, e, sel) },
                            onTap = {
                                when {
                                    // A normal tap elsewhere cancels an in-progress selection.
                                    wordSel != null -> wordSel = null
                                    highlightsByPara.containsKey(index) -> sheetTarget = SheetTarget.View(index)
                                }
                            }
                        )
                    }
                }
                // Confirm bar for a word-level selection, pinned under the list.
                wordSel?.let { sel ->
                    Surface(
                        tonalElevation = 3.dp,
                        color = MaterialTheme.colorScheme.surfaceVariant,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = "“${sel.text}”",
                                style = MaterialTheme.typography.bodySmall,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f)
                            )
                            TextButton(onClick = { wordSel = null }) { Text("Cancel") }
                            TextButton(onClick = {
                                sheetTarget = SheetTarget.Create(sel.block, sel.text)
                                wordSel = null
                            }) { Text("Edit") }
                            Button(onClick = {
                                repo.addHighlight(articleId, sel.text, null, sel.block)
                                wordSel = null
                                scope.launch { snackbarHostState.showSnackbar("Highlighted") }
                            }) { Text("Highlight") }
                        }
                    }
                }
                }
            }
        }
    }

    // Resume chooser: reading vs listening position, each paused (default) or
    // playing. Whichever spot you pick becomes the listening position too, so
    // pressing play later starts from there.
    resumeChoice?.let { (read, tts) ->
        val total = blocks.size.coerceAtLeast(1)
        val readPct = ((read + 1) * 100 / total).coerceIn(1, 100)
        val ttsPct = ((tts + 1) * 100 / total).coerceIn(1, 100)
        fun resumeAt(pos: Int, play: Boolean) {
            resumeChoice = null
            followTts = true
            repo.saveTtsPosition(articleId, pos) // sync the listening position to the chosen spot
            if (play) sendTtsCommand(context, TtsService.ACTION_PLAY, articleId, pos)
            scope.launch { listState.scrollToBlock(pos) }
        }
        AlertDialog(
            onDismissRequest = { resumeChoice = null },
            title = { Text("Resume where?") },
            text = {
                Column {
                    Text("Your reading and listening positions differ. Pick where to continue.")
                    Spacer(modifier = Modifier.height(12.dp))
                    TextButton(onClick = { resumeAt(read, false) }, modifier = Modifier.fillMaxWidth()) {
                        Text("Reading position · $readPct% (paused)")
                    }
                    TextButton(onClick = { resumeAt(tts, false) }, modifier = Modifier.fillMaxWidth()) {
                        Text("Listening position · $ttsPct% (paused)")
                    }
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        "…or start playing:",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    TextButton(onClick = { resumeAt(read, true) }, modifier = Modifier.fillMaxWidth()) {
                        Text("▶️ Reading position · $readPct% (play)")
                    }
                    TextButton(onClick = { resumeAt(tts, true) }, modifier = Modifier.fillMaxWidth()) {
                        Text("▶️ Listening position · $ttsPct% (play)")
                    }
                }
            },
            confirmButton = {},
            dismissButton = {
                TextButton(onClick = { resumeChoice = null }) { Text("Cancel") }
            }
        )
    }

    if (sleepDialog) {
        fun setSleep(minutes: Int) {
            sleepDialog = false
            context.startService(
                Intent(context, TtsService::class.java)
                    .setAction(TtsService.ACTION_SET_SLEEP_TIMER)
                    .putExtra(TtsService.EXTRA_SLEEP_MINUTES, minutes)
            )
        }
        val active = ttsState.sleepTimerEndsAt > android.os.SystemClock.elapsedRealtime()
        AlertDialog(
            onDismissRequest = { sleepDialog = false },
            title = { Text("Sleep timer") },
            text = {
                Column {
                    Text("Pause playback after:")
                    Spacer(modifier = Modifier.height(8.dp))
                    listOf(15, 30, 45, 60).forEach { m ->
                        TextButton(onClick = { setSleep(m) }, modifier = Modifier.fillMaxWidth()) {
                            Text("$m minutes")
                        }
                    }
                    if (active) {
                        TextButton(onClick = { setSleep(0) }, modifier = Modifier.fillMaxWidth()) {
                            Text("Turn off")
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { sleepDialog = false }) { Text("Cancel") } }
        )
    }

    // "Report bad parse": pick what's wrong; we re-extract server-side and the
    // reader updates itself when the refreshed article flows back in.
    if (reparseDialog) {
        fun doReparse(hint: String) {
            reparsing = true
            scope.launch {
                val result = runCatching { repo.reparseArticle(articleId, hint) }.getOrNull()
                reparsing = false
                reparseDialog = false
                snackbarHostState.showSnackbar(when {
                    result == null -> "Reparse failed — check your connection"
                    result.ok -> "Reparsed with ${if (result.method.startsWith("readability")) "Readability" else "AI"}"
                    result.reason == "no-source" -> "No saved original to reparse this one from"
                    else -> "Couldn't get a better parse"
                })
            }
        }
        AlertDialog(
            onDismissRequest = { if (!reparsing) reparseDialog = false },
            title = { Text("Report bad parse") },
            text = {
                Column {
                    if (reparsing) {
                        Text("Reparsing… this can take a few seconds.")
                        Spacer(modifier = Modifier.height(12.dp))
                        LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    } else {
                        Text("What's wrong with how this article was parsed? We'll re-extract it from the original source.")
                        Spacer(modifier = Modifier.height(12.dp))
                        TextButton(onClick = { doReparse("too-short") }, modifier = Modifier.fillMaxWidth()) {
                            Text("Too short — text is missing")
                        }
                        TextButton(onClick = { doReparse("too-long") }, modifier = Modifier.fillMaxWidth()) {
                            Text("Too long — extra menus / ads / junk")
                        }
                        TextButton(onClick = { doReparse("other") }, modifier = Modifier.fillMaxWidth()) {
                            Text("Something else looks wrong")
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = {
                if (!reparsing) TextButton(onClick = { reparseDialog = false }) { Text("Cancel") }
            }
        )
    }

    // Full-screen viewer for the raw captured original (email/PDF source).
    // JavaScript stays off so the untrusted source can't run code.
    sourceView?.let { rawHtml ->
        Dialog(
            onDismissRequest = { sourceView = null },
            properties = DialogProperties(usePlatformDefaultWidth = false)
        ) {
            Surface(modifier = Modifier.fillMaxSize()) {
                Column(modifier = Modifier.fillMaxSize()) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 4.dp, bottom = 4.dp)
                    ) {
                        Text("Original source", modifier = Modifier.weight(1f))
                        IconButton(onClick = { sourceView = null }) {
                            Icon(Icons.Filled.Close, contentDescription = "Close")
                        }
                    }
                    AndroidView(
                        modifier = Modifier.fillMaxWidth().weight(1f),
                        factory = { ctx ->
                            WebView(ctx).apply {
                                // `settings` (unqualified) would resolve to the app Settings in
                                // this scope — use the WebView's own settings explicitly.
                                val ws = this.settings
                                ws.javaScriptEnabled = false
                                ws.loadWithOverviewMode = true
                                ws.useWideViewPort = true
                            }
                        },
                        update = { it.loadDataWithBaseURL(null, rawHtml, "text/html", "utf-8", null) }
                    )
                }
            }
        }
    }

    val target = sheetTarget
    if (target != null) {
        ModalBottomSheet(onDismissRequest = { sheetTarget = null }) {
            when (target) {
                is SheetTarget.Create -> CreateHighlightSheet(
                    initialText = target.text,
                    onPlayFromHere = {
                        sendTtsCommand(context, TtsService.ACTION_PLAY, articleId, target.index)
                        sheetTarget = null
                    },
                    onNeverImport = { phrase ->
                        sheetTarget = null
                        scope.launch {
                            repo.addSkipRule(phrase)
                                .onSuccess { existing ->
                                    snackbarHostState.showSnackbar(
                                        if (existing > 0)
                                            "Skipped in future saves ($existing saved article(s) keep it)"
                                        else "Skipped in future saves"
                                    )
                                }
                                .onFailure {
                                    snackbarHostState.showSnackbar("Could not add that rule")
                                }
                        }
                    },
                    onSave = { text, note ->
                        repo.addHighlight(articleId, text, note, target.index)
                        sheetTarget = null
                    }
                )

                is SheetTarget.View -> ViewHighlightsSheet(
                    highlights = highlightsByPara[target.index].orEmpty(),
                    onDelete = { h -> repo.deleteHighlight(h.clientId, h.serverId) }
                )
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
/** Plain speakable/searchable text of a block ("" for images without alt). */
private val headerDateFmt = java.text.SimpleDateFormat("MMM d, yyyy", java.util.Locale.US)

/** Title + byline metadata shown above the article body. */
@Composable
private fun ArticleHeader(article: com.readlater.app.data.ArticleEntity) {
    Column(modifier = Modifier.fillMaxWidth().padding(bottom = 18.dp)) {
        Text(
            text = article.title.ifBlank { article.url },
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
            lineHeight = MaterialTheme.typography.headlineSmall.fontSize * 1.15f
        )
        val publisher = article.siteName?.takeIf { it.isNotBlank() }
            ?: runCatching { Uri.parse(article.url).host?.removePrefix("www.") }.getOrNull()
        val dateMs = article.publishedAt ?: article.savedAt.takeIf { it > 0 }
        val date = dateMs?.let {
            (if (article.publishedAt == null) "Saved " else "") + headerDateFmt.format(java.util.Date(it))
        }
        val minutes = readingMinutes(article.wordCount)
        val meta = listOfNotNull(
            article.byline?.takeIf { it.isNotBlank() },
            publisher,
            date,
            if (minutes > 0) "$minutes min read" else null
        ).joinToString(" · ")
        if (meta.isNotBlank()) {
            Spacer(modifier = Modifier.height(10.dp))
            Text(
                text = meta,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        Spacer(modifier = Modifier.height(14.dp))
        androidx.compose.material3.HorizontalDivider()
    }
}

private fun blockPlainText(block: Block): String = when (block) {
    is Block.Paragraph -> block.text
    is Block.Heading -> block.text
    is Block.Quote -> block.text
    is Block.ImageBlock -> block.alt.orEmpty()
}

private val SearchMatchColor = Color(0x804FC3F7) // distinct from the amber highlight

/** Add a background span for every case-insensitive occurrence of [query]. */
private fun androidx.compose.ui.text.AnnotatedString.Builder.addSearchSpans(text: String, query: String) {
    if (query.length < 2) return
    var i = text.indexOf(query, 0, ignoreCase = true)
    while (i >= 0) {
        addStyle(SpanStyle(background = SearchMatchColor), i, i + query.length)
        i = text.indexOf(query, i + query.length, ignoreCase = true)
    }
}

@Composable
private fun BlockItem(
    block: Block,
    paraHighlights: List<HighlightEntity>,
    searchQuery: String,
    isSpoken: Boolean,
    selRange: IntRange?,
    onDoubleTap: (String) -> Unit,
    onWordSelect: (start: Int, end: Int, selected: String) -> Unit,
    onTap: () -> Unit
) {
    when (block) {
        is Block.Heading -> {
            val style = when (block.level) {
                1 -> MaterialTheme.typography.headlineMedium
                2 -> MaterialTheme.typography.headlineSmall
                3 -> MaterialTheme.typography.titleLarge
                else -> MaterialTheme.typography.titleMedium
            }
            Text(
                text = remember(block.text, searchQuery) {
                    buildAnnotatedString { append(block.text); addSearchSpans(block.text, searchQuery) }
                },
                style = style,
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(MaterialTheme.shapes.small)
                    .spokenOutline(isSpoken)
                    .padding(vertical = 12.dp)
            )
        }

        is Block.ImageBlock -> {
            Surface(
                color = MaterialTheme.colorScheme.surfaceVariant,
                shape = MaterialTheme.shapes.small,
                modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)
            ) {
                Text(
                    text = "[image: ${block.alt ?: block.src}]",
                    style = MaterialTheme.typography.bodySmall,
                    fontStyle = FontStyle.Italic,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(12.dp)
                )
            }
        }

        is Block.Paragraph -> HighlightableText(
            text = block.text,
            isQuote = false,
            paraHighlights = paraHighlights,
            searchQuery = searchQuery,
            isSpoken = isSpoken,
            selRange = selRange,
            onDoubleTap = onDoubleTap,
            onWordSelect = onWordSelect,
            onTap = onTap
        )

        is Block.Quote -> HighlightableText(
            text = block.text,
            isQuote = true,
            paraHighlights = paraHighlights,
            searchQuery = searchQuery,
            isSpoken = isSpoken,
            selRange = selRange,
            onDoubleTap = onDoubleTap,
            onWordSelect = onWordSelect,
            onTap = onTap
        )
    }
}

private val HighlightSpanColor = Color(0x66FFE082)
private val HighlightTintColor = Color(0x33FFE082)
private val PendingSelColor = Color(0x554A90D9) // blue: word(s) being selected

/** Outline marking the paragraph TTS is reading — deliberately not a fill,
 *  so it can't be mistaken for the amber highlight tint. */
@Composable
private fun Modifier.spokenOutline(isSpoken: Boolean): Modifier =
    if (isSpoken) {
        this.border(2.dp, MaterialTheme.colorScheme.primary, MaterialTheme.shapes.small)
    } else this

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun HighlightableText(
    text: String,
    isQuote: Boolean,
    paraHighlights: List<HighlightEntity>,
    searchQuery: String,
    isSpoken: Boolean,
    selRange: IntRange?,
    onDoubleTap: (String) -> Unit,
    onWordSelect: (start: Int, end: Int, selected: String) -> Unit,
    onTap: () -> Unit
) {
    // Render each highlight whose text is a substring of the paragraph as an inline
    // background span; if any highlight doesn't match, tint the whole paragraph.
    val annotated = remember(text, paraHighlights, searchQuery, selRange) {
        buildAnnotatedString {
            append(text)
            for (h in paraHighlights) {
                val start = text.indexOf(h.text)
                if (start >= 0) {
                    addStyle(SpanStyle(background = HighlightSpanColor), start, start + h.text.length)
                }
            }
            // The word(s) currently being selected — a distinct blue so it can't
            // be confused with a committed (amber) highlight.
            selRange?.let { addStyle(SpanStyle(background = PendingSelColor), it.first, it.last + 1) }
            addSearchSpans(text, searchQuery)
        }
    }

    // Layout, so a touch point can be mapped to the word under the finger.
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
    fun wordAt(pos: Offset): IntRange? {
        val l = layout ?: return null
        val off = l.getOffsetForPosition(pos).coerceIn(0, text.length)
        val w = l.getWordBoundary(off)
        return if (w.start < w.end) w.start until w.end else null
    }
    val gestures = Modifier
        .pointerInput(text) {
            detectTapGestures(
                onTap = { onTap() },
                onDoubleTap = { onDoubleTap(text) } // whole-paragraph highlight
            )
        }
        // Press and hold, then drag across words to select a span. The word
        // under the initial press is the anchor; dragging grows or shrinks the
        // range between the anchor and the word under the finger.
        .pointerInput(text) {
            var aStart = 0
            var aEnd = 0
            detectDragGesturesAfterLongPress(
                onDragStart = { pos ->
                    wordAt(pos)?.let {
                        aStart = it.first; aEnd = it.last + 1
                        onWordSelect(aStart, aEnd, text.substring(aStart, aEnd))
                    }
                },
                onDrag = { change, _ ->
                    change.consume()
                    wordAt(change.position)?.let {
                        val s = minOf(aStart, it.first)
                        val e = maxOf(aEnd, it.last + 1)
                        onWordSelect(s, e, text.substring(s, e))
                    }
                }
            )
        }
    val hasUnmatchedHighlight = remember(text, paraHighlights) {
        paraHighlights.any { text.indexOf(it.text) < 0 }
    }
    // Highlights are an amber FILL; the paragraph being read aloud gets a
    // primary-color OUTLINE instead, so the two can't be confused.
    val backgroundColor = when {
        paraHighlights.isNotEmpty() && hasUnmatchedHighlight -> HighlightTintColor
        else -> Color.Transparent
    }

    if (isQuote) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 6.dp)
                .clip(MaterialTheme.shapes.small)
                .spokenOutline(isSpoken)
                .background(backgroundColor)
                .height(IntrinsicSize.Min)
        ) {
            Box(
                modifier = Modifier
                    .width(3.dp)
                    .fillMaxHeight()
                    .background(MaterialTheme.colorScheme.primary)
            )
            Text(
                text = annotated,
                style = ReadingTextStyle.copy(fontStyle = FontStyle.Italic),
                onTextLayout = { layout = it },
                modifier = Modifier
                    .padding(start = 14.dp, top = 4.dp, bottom = 4.dp, end = 4.dp)
                    .then(gestures)
            )
        }
    } else {
        Text(
            text = annotated,
            style = ReadingTextStyle,
            onTextLayout = { layout = it },
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 6.dp)
                .clip(MaterialTheme.shapes.small)
                .spokenOutline(isSpoken)
                .background(backgroundColor)
                .then(gestures)
                .padding(4.dp)
        )
    }
}

@Composable
private fun CreateHighlightSheet(
    initialText: String,
    onPlayFromHere: () -> Unit,
    onNeverImport: (text: String) -> Unit,
    onSave: (text: String, note: String?) -> Unit
) {
    var text by remember(initialText) { mutableStateOf(initialText) }
    var note by remember(initialText) { mutableStateOf("") }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp)
            .padding(bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("New highlight", style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            label = { Text("Highlighted text (trim to what you want)") },
            minLines = 3,
            maxLines = 8,
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = note,
            onValueChange = { note = it },
            label = { Text("Note (optional)") },
            modifier = Modifier.fillMaxWidth()
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onPlayFromHere) {
                Icon(Icons.Filled.PlayArrow, contentDescription = null)
                Spacer(modifier = Modifier.width(4.dp))
                Text("Play from here")
            }
            Spacer(modifier = Modifier.weight(1f))
            Button(
                enabled = text.isNotBlank(),
                onClick = { onSave(text.trim(), note.trim().ifBlank { null }) }
            ) {
                Text("Save highlight")
            }
        }
        androidx.compose.material3.HorizontalDivider()
        // Boilerplate, not a highlight. Trim the field above to the phrase
        // first. The server needs at least 8 characters so a stray word can't
        // start deleting paragraphs from everything you save.
        TextButton(
            enabled = text.trim().length >= MIN_SKIP_PHRASE,
            onClick = { onNeverImport(text.trim()) }
        ) {
            Icon(Icons.Filled.Block, contentDescription = null)
            Spacer(modifier = Modifier.width(4.dp))
            Text("Never import this text again")
        }
        Text(
            "Paragraphs containing this are dropped from articles you save from " +
                "now on. Articles already saved are left as they are.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

/** Mirrors MIN_PHRASE_CHARS in the server's skip.js. */
private const val MIN_SKIP_PHRASE = 8

@Composable
private fun ViewHighlightsSheet(
    highlights: List<HighlightEntity>,
    onDelete: (HighlightEntity) -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp)
            .padding(bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("Highlights on this paragraph", style = MaterialTheme.typography.titleMedium)
        if (highlights.isEmpty()) {
            Text(
                text = "No highlights here anymore.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        highlights.forEach { h ->
            Row(verticalAlignment = Alignment.Top) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "“${h.text}”",
                        style = MaterialTheme.typography.bodyMedium
                    )
                    h.note?.takeIf { it.isNotBlank() }?.let { note ->
                        Text(
                            text = note,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 4.dp)
                        )
                    }
                }
                IconButton(onClick = { onDelete(h) }) {
                    Icon(Icons.Filled.Delete, contentDescription = "Delete highlight")
                }
            }
        }
    }
}
