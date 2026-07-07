package com.readlater.app.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Archive
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

/** What the reader's bottom sheet is currently showing. */
private sealed class SheetTarget {
    data class Create(val index: Int, val text: String) : SheetTarget()
    data class View(val index: Int) : SheetTarget()
}

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
            if (read > 0 && tts > 0 && kotlin.math.abs(read - tts) > 2) {
                listState.scrollToItem(minOf(read, tts))
                resumeChoice = read to tts
            } else {
                listState.scrollToItem(maxOf(read, tts))
            }
            didInitialScroll = true
        }
    }

    // Follow the paragraph currently being spoken (unless the user scrolled away).
    LaunchedEffect(ttsState.paragraphIndex, ttsState.isPlaying, isTtsThisArticle, followTts) {
        if (followTts && isTtsThisArticle && ttsState.isPlaying &&
            ttsState.paragraphIndex in blocks.indices
        ) {
            listState.animateScrollToItem(ttsState.paragraphIndex)
        }
    }

    // Continuously persist the manual scroll position (debounced, local-only;
    // the dirty flag gets it pushed on the next sync). Survives the app being
    // killed mid-read. Suspended only while auto-follow is driving the scroll —
    // TTS keeps its own separate position.
    LaunchedEffect(didInitialScroll, isTtsThisArticle, ttsState.isPlaying, followTts) {
        if (!didInitialScroll || (isTtsThisArticle && ttsState.isPlaying && followTts)) return@LaunchedEffect
        snapshotFlow { listState.firstVisibleItemIndex }
            .distinctUntilChanged()
            .debounce(800)
            .collect { index ->
                if (currentBlocks.isNotEmpty()) {
                    repo.saveReadPositionLocal(articleId, index.coerceIn(0, currentBlocks.size - 1))
                }
            }
    }

    // Persist the reading position when leaving the screen (works without TTS too).
    DisposableEffect(articleId) {
        onDispose {
            if (didInitialScroll && currentBlocks.isNotEmpty()) {
                val index = listState.firstVisibleItemIndex.coerceIn(0, currentBlocks.size - 1)
                repo.saveReadPosition(articleId, index)
            }
        }
    }

    var speechRate by remember { mutableStateOf(settings.ttsSpeechRate) }
    var sheetTarget by remember { mutableStateOf<SheetTarget?>(null) }
    var menuOpen by remember { mutableStateOf(false) }

    // How far through the article the bottom of the viewport is (0..1).
    val readProgress by remember {
        derivedStateOf {
            val total = currentBlocks.size
            if (total == 0) 0f
            else {
                val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
                ((last + 1).toFloat() / total).coerceIn(0f, 1f)
            }
        }
    }

    fun changeRate(delta: Float) {
        val newRate = (speechRate + delta).coerceIn(0.5f, 2.0f)
        if (newRate == speechRate) return
        speechRate = newRate
        settings.ttsSpeechRate = newRate
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
        if (matchBlocks.isNotEmpty()) listState.scrollToItem(matchBlocks[0])
    }
    fun goToMatch(delta: Int) {
        if (matchBlocks.isEmpty()) return
        currentMatch = ((currentMatch + delta) % matchBlocks.size + matchBlocks.size) % matchBlocks.size
        scope.launch { listState.scrollToItem(matchBlocks[currentMatch]) }
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
                title = {
                    Column {
                        Text(
                            text = article?.title.orEmpty(),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                        if (blocks.isNotEmpty()) {
                            val pct = (readProgress * 100).toInt()
                            val wordsLeft = ((article?.wordCount ?: 0) * (1 - readProgress)).toInt()
                            val minutesLeft = if (wordsLeft > 0) (wordsLeft / 225.0).let {
                                kotlin.math.max(1, kotlin.math.round(it).toInt())
                            } else 0
                            Text(
                                text = if (minutesLeft > 0 && pct < 100) "$pct% · $minutesLeft min left" else "$pct%",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
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
                        IconButton(onClick = { repo.toggleFavorite(a) }) {
                            Icon(
                                if (a.favorite) Icons.Filled.Star else Icons.Filled.StarBorder,
                                contentDescription = if (a.favorite) "Unfavorite" else "Favorite",
                                tint = if (a.favorite) MaterialTheme.colorScheme.tertiary
                                else LocalContentColor.current
                            )
                        }
                        IconButton(onClick = {
                            val wasArchived = a.archived
                            val ttsOnThis = isTtsThisArticle
                            repo.toggleArchive(a)
                            // Archiving finishes reading — return to the list. If
                            // this article was the one being read aloud, advance
                            // the listening queue to the next inbox article.
                            if (!wasArchived) {
                                if (ttsOnThis) {
                                    scope.launch {
                                        val next = repo.nextInboxArticle(a)
                                        if (next != null) {
                                            sendTtsCommand(context, TtsService.ACTION_PLAY, next.id, 0)
                                            onOpenArticle(next.id) // open the next article's reader
                                        } else {
                                            sendTtsCommand(context, TtsService.ACTION_STOP)
                                            onBack()
                                        }
                                    }
                                } else {
                                    onBack()
                                }
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
                                    text = { Text("Open original") },
                                    leadingIcon = {
                                        Icon(Icons.Filled.OpenInBrowser, contentDescription = null)
                                    },
                                    onClick = {
                                        menuOpen = false
                                        try {
                                            context.startActivity(
                                                Intent(Intent.ACTION_VIEW, Uri.parse(a.url))
                                            )
                                        } catch (_: Exception) {
                                            // No browser available — ignore.
                                        }
                                    }
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
                                    listState.firstVisibleItemIndex
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
                // Jump the view back to the reading position and resume following.
                IconButton(onClick = {
                    followTts = true
                    val target = if (isTtsThisArticle) ttsState.paragraphIndex
                    else article?.readParagraph ?: 0
                    scope.launch {
                        if (blocks.isNotEmpty()) {
                            listState.animateScrollToItem(target.coerceIn(0, blocks.size - 1))
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
                    val idx = listState.firstVisibleItemIndex
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
                IconButton(onClick = { changeRate(-0.25f) }, enabled = speechRate > 0.5f) {
                    Icon(Icons.Filled.Remove, contentDescription = "Slower")
                }
                Text(
                    text = String.format(Locale.US, "%.2f×", speechRate),
                    style = MaterialTheme.typography.labelLarge
                )
                IconButton(onClick = { changeRate(0.25f) }, enabled = speechRate < 2.0f) {
                    Icon(Icons.Filled.Add, contentDescription = "Faster")
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
                    itemsIndexed(blocks) { index, block ->
                        BlockItem(
                            block = block,
                            paraHighlights = highlightsByPara[index].orEmpty(),
                            searchQuery = if (searchActive) searchQuery.trim() else "",
                            isSpoken = isTtsThisArticle && ttsState.paragraphIndex == index,
                            onLongPress = { text ->
                                sheetTarget = SheetTarget.Create(index, text)
                            },
                            onDoubleTap = { text ->
                                repo.addHighlight(articleId, text, null, index)
                                scope.launch { snackbarHostState.showSnackbar("Highlighted") }
                            },
                            onTap = {
                                if (highlightsByPara.containsKey(index)) {
                                    sheetTarget = SheetTarget.View(index)
                                }
                            }
                        )
                    }
                }
                }
            }
        }
    }

    // Resume chooser: manual scroll position vs listening position.
    resumeChoice?.let { (read, tts) ->
        val total = blocks.size.coerceAtLeast(1)
        val readPct = ((read + 1) * 100 / total).coerceIn(1, 100)
        val ttsPct = ((tts + 1) * 100 / total).coerceIn(1, 100)
        AlertDialog(
            onDismissRequest = { resumeChoice = null },
            title = { Text("Resume where?") },
            text = { Text("Your reading and listening positions differ.") },
            confirmButton = {
                TextButton(onClick = {
                    resumeChoice = null
                    scope.launch { listState.scrollToItem(read) }
                }) { Text("Reading · $readPct%") }
            },
            dismissButton = {
                TextButton(onClick = {
                    resumeChoice = null
                    followTts = true
                    // Resuming the listening position starts playback from there.
                    sendTtsCommand(context, TtsService.ACTION_PLAY, articleId, tts)
                    scope.launch { listState.scrollToItem(tts) }
                }) { Text("Listening · $ttsPct%") }
            }
        )
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
    onLongPress: (String) -> Unit,
    onDoubleTap: (String) -> Unit,
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
            onLongPress = onLongPress,
            onDoubleTap = onDoubleTap,
            onTap = onTap
        )

        is Block.Quote -> HighlightableText(
            text = block.text,
            isQuote = true,
            paraHighlights = paraHighlights,
            searchQuery = searchQuery,
            isSpoken = isSpoken,
            onLongPress = onLongPress,
            onDoubleTap = onDoubleTap,
            onTap = onTap
        )
    }
}

private val HighlightSpanColor = Color(0x66FFE082)
private val HighlightTintColor = Color(0x33FFE082)

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
    onLongPress: (String) -> Unit,
    onDoubleTap: (String) -> Unit,
    onTap: () -> Unit
) {
    // Render each highlight whose text is a substring of the paragraph as an inline
    // background span; if any highlight doesn't match, tint the whole paragraph.
    val annotated = remember(text, paraHighlights, searchQuery) {
        buildAnnotatedString {
            append(text)
            for (h in paraHighlights) {
                val start = text.indexOf(h.text)
                if (start >= 0) {
                    addStyle(SpanStyle(background = HighlightSpanColor), start, start + h.text.length)
                }
            }
            addSearchSpans(text, searchQuery)
        }
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
                .combinedClickable(
                    onClick = onTap,
                    onLongClick = { onLongPress(text) },
                    onDoubleClick = { onDoubleTap(text) }
                )
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
                modifier = Modifier.padding(start = 14.dp, top = 4.dp, bottom = 4.dp, end = 4.dp)
            )
        }
    } else {
        Text(
            text = annotated,
            style = ReadingTextStyle,
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 6.dp)
                .clip(MaterialTheme.shapes.small)
                .spokenOutline(isSpoken)
                .background(backgroundColor)
                .combinedClickable(
                    onClick = onTap,
                    onLongClick = { onLongPress(text) },
                    onDoubleClick = { onDoubleTap(text) }
                )
                .padding(4.dp)
        )
    }
}

@Composable
private fun CreateHighlightSheet(
    initialText: String,
    onPlayFromHere: () -> Unit,
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
    }
}

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
